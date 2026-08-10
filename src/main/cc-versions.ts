import { app } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// cc 多版本管理：每版装到 <userData>/cc-versions/<version>/（npm install -g --prefix 隔离），
// 切换 = 把 settings.claudePath 指向对应 claude.cmd；登录态在 ~/.claude/ 全局共享，不用重登。

export const CC_PACKAGE = '@anthropic-ai/claude-code'
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

const IS_WIN = process.platform === 'win32'

// npm --prefix 产物布局：Windows 在 <dir>/ 根下；类 Unix 在 <dir>/bin 与 <dir>/lib/node_modules
function claudeBinPath(prefix: string): string {
  return IS_WIN ? join(prefix, 'claude.cmd') : join(prefix, 'bin', 'claude')
}
function pkgJsonPath(prefix: string): string {
  return IS_WIN
    ? join(prefix, 'node_modules', CC_PACKAGE, 'package.json')
    : join(prefix, 'lib', 'node_modules', CC_PACKAGE, 'package.json')
}
// 从 claude 可执行路径反推安装 prefix
function prefixFromClaudeBin(binPath: string): string {
  return IS_WIN ? dirname(binPath) : dirname(dirname(binPath))
}

// 用登录 shell 解析命令绝对路径（macOS GUI 进程 PATH 极简）
function whichViaLoginShell(name: string): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const lines = execFileSync(shell, ['-lic', `command -v ${name}`], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const line = lines.reverse().find((l) => l.startsWith('/') && existsSync(l))
    return line || null
  } catch {
    return null
  }
}

export interface InstalledVersion {
  version: string
  path: string        // claude.cmd 绝对路径
  installedAt: number // 目录 mtime，用于排序兜底
  active: boolean     // 当前 settings.claudePath 是否指向这一版
}

export interface InstallResult {
  ok: boolean
  version: string
  path?: string
  error?: string
}


function versionsRoot(): string {
  const d = join(app.getPath('userData'), 'cc-versions')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// 版本目录名白名单，挡掉目录穿越
const VERSION_RE = /^[A-Za-z0-9._+-]+$/

// 简易 semver 比较：pre-release 视为更小
function cmpSemver(a: string, b: string): number {
  const [ah, ap = ''] = a.split('-', 2)
  const [bh, bp = ''] = b.split('-', 2)
  const pa = ah.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = bh.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

// 找系统 npm；结果缓存到进程生命周期
let cachedNpm: string | null | undefined
export function detectNpm(): string | null {
  if (cachedNpm !== undefined) return cachedNpm
  if (!IS_WIN) {
    cachedNpm = whichViaLoginShell('npm')
    return cachedNpm
  }
  const tryOne = (name: string): string | null => {
    try {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l))
      return line || null
    } catch {
      return null
    }
  }
  cachedNpm = tryOne('npm.cmd') || tryOne('npm') || null
  return cachedNpm
}

// npm 调用形式 spawn(file, [...lead, ...args])。Windows 上 Node 20+ 因 CVE-2024-27980
// 禁止直接 spawn .cmd，改用 node.exe + npm-cli.js 跑（兼容 nvm4w / msi / winget 布局）。
interface NpmInvocation { file: string; lead: string[] }
let cachedInvoke: NpmInvocation | null | undefined
function resolveNpmInvocation(): NpmInvocation | null {
  if (cachedInvoke !== undefined) return cachedInvoke
  const npmCmd = detectNpm()
  if (!npmCmd) { cachedInvoke = null; return null }
  if (!IS_WIN) {
    cachedInvoke = { file: npmCmd, lead: [] }
    return cachedInvoke
  }
  const dir = dirname(npmCmd)
  const candidates: Array<{ node: string; cli: string }> = [
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') },
    // nvm4w 的 npm.cmd 有时是 shim，真正 npm 在同层 node_modules
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'lib', 'npm.js') }
  ]
  for (const c of candidates) {
    if (existsSync(c.node) && existsSync(c.cli)) {
      cachedInvoke = { file: c.node, lead: [c.cli] }
      return cachedInvoke
    }
  }
  try {
    const out = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true })
    const nodeExe = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l))
    if (nodeExe) {
      const cli = join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(cli)) { cachedInvoke = { file: nodeExe, lead: [cli] }; return cachedInvoke }
    }
  } catch {}
  cachedInvoke = null
  return null
}

// registry URL 白名单校验，挡掉 shell 元字符
const REGISTRY_RE = /^https?:\/\/[A-Za-z0-9._~\-/:@%?&=+]+$/
function safeRegistry(reg: string): string {
  const v = (reg || '').trim() || DEFAULT_NPM_REGISTRY
  return REGISTRY_RE.test(v) ? v : DEFAULT_NPM_REGISTRY
}

function readPkgVersion(dir: string): string | null {
  try {
    const p = pkgJsonPath(dir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

export function listInstalled(activePath: string): InstalledVersion[] {
  const root = versionsRoot()
  const active = (activePath || '').toLowerCase()
  const out: InstalledVersion[] = []
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return [] }
  for (const name of entries) {
    if (!VERSION_RE.test(name)) continue
    const dir = join(root, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    const pkgVer = readPkgVersion(dir)
    if (!pkgVer) continue
    const cmd = claudeBinPath(dir)
    if (!existsSync(cmd)) continue
    out.push({
      version: pkgVer,
      path: cmd,
      installedAt: st.mtimeMs,
      active: cmd.toLowerCase() === active
    })
  }
  out.sort((a, b) => cmpSemver(b.version, a.version))
  return out
}

// 从任意 claude 可执行路径反查版本号：先按托管布局反推 prefix 读版本，
// 再向上逐级找 @anthropic-ai/claude-code/package.json；找不到返回 null。
export function versionFromPath(claudePath: string): string | null {
  if (!claudePath) return null
  const prefix = prefixFromClaudeBin(claudePath)
  const v1 = readPkgVersion(prefix)
  if (v1) return v1
  let cur = claudePath
  for (let i = 0; i < 8; i++) {
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
    try {
      const pkgPath = join(cur, 'package.json')
      if (existsSync(pkgPath)) {
        const j = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (j.name === CC_PACKAGE && typeof j.version === 'string') return j.version
      }
    } catch {}
  }
  return null
}

export async function listRemote(registry: string): Promise<string[]> {
  const inv = resolveNpmInvocation()
  if (!inv) throw new Error('未找到 npm，请检查 Node.js 安装')
  const reg = safeRegistry(registry)
  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      [...inv.lead, 'view', CC_PACKAGE, 'versions', '--json', `--registry=${reg}`],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message))
        try {
          const raw = JSON.parse(stdout) as unknown
          const arr = Array.isArray(raw) ? raw.map(String) : []
          arr.sort(cmpSemver).reverse()
          resolve(arr)
        } catch (e) {
          reject(e as Error)
        }
      }
    )
  })
}

// 在跑的安装进程，key = version，供 cancel 调用
interface InflightInstall {
  proc: ReturnType<typeof spawn>
  prefix: string
  createdDir: boolean  // 本次安装新建的目录 → 取消/失败时可整目录清理
  cancelled: boolean
}
const inflightInstalls = new Map<string, InflightInstall>()

// 剥离 npm progress 输出里的 ANSI 转义序列
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function install(
  version: string,
  registry: string,
  onPhase: (phase: string) => void
): Promise<InstallResult> {
  const ver = version.trim()
  if (!VERSION_RE.test(ver) && ver !== 'latest') {
    return Promise.resolve({ ok: false, version: ver, error: '版本号格式非法' })
  }
  if (inflightInstalls.has(ver)) {
    return Promise.resolve({ ok: false, version: ver, error: '同一版本正在安装中' })
  }
  const inv = resolveNpmInvocation()
  if (!inv) return Promise.resolve({ ok: false, version: ver, error: '未找到 npm' })
  const reg = safeRegistry(registry)
  // latest 先装到临时目录，装完读真实版本改名
  const useTmp = ver === 'latest'
  const dirName = useTmp ? `_pending_${Date.now()}` : ver
  const prefix = join(versionsRoot(), dirName)
  const createdDir = !existsSync(prefix)
  if (createdDir) mkdirSync(prefix, { recursive: true })
  const args = [
    ...inv.lead,
    'install', '-g', `${CC_PACKAGE}@${ver}`,
    `--prefix=${prefix}`,
    `--registry=${reg}`,
    '--no-audit', '--no-fund', '--no-package-lock'
  ]
  onPhase('准备…')
  return new Promise((resolve) => {
    const p = spawn(inv.file, args, { windowsHide: true })
    const state: InflightInstall = { proc: p, prefix, createdDir, cancelled: false }
    inflightInstalls.set(ver, state)
    const cleanupOnFail = (): void => {
      // 只清理本次新建的目录，已装的同版本不能误删
      if (state.createdDir) { try { rmSync(prefix, { recursive: true, force: true }) } catch {} }
    }
    // 从 npm stdout/stderr（progress 走 stderr）抽取最新一行作为 phase，节流上报
    let lastPhaseSent = ''
    let lastSendTs = 0
    const handleChunk = (buf: Buffer): void => {
      const clean = buf.toString().replace(ANSI_RE, '').replace(/\r/g, '\n')
      const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 200)
      if (!lines.length) return
      const line = lines[lines.length - 1]
      if (line === lastPhaseSent) return
      const now = Date.now()
      if (now - lastSendTs < 250) return
      lastPhaseSent = line
      lastSendTs = now
      onPhase(line)
    }
    p.stdout.on('data', handleChunk)
    p.stderr.on('data', handleChunk)
    p.on('error', (e) => {
      inflightInstalls.delete(ver)
      cleanupOnFail()
      resolve({ ok: false, version: ver, error: e.message })
    })
    p.on('exit', (code) => {
      inflightInstalls.delete(ver)
      if (state.cancelled) {
        cleanupOnFail()
        return resolve({ ok: false, version: ver, error: '已取消' })
      }
      if (code !== 0) {
        cleanupOnFail()
        return resolve({ ok: false, version: ver, error: `npm 退出码 ${code}` })
      }
      const realVer = readPkgVersion(prefix) ?? ver
      let finalPrefix = prefix
      if (useTmp) {
        finalPrefix = join(versionsRoot(), realVer)
        try {
          if (existsSync(finalPrefix)) rmSync(finalPrefix, { recursive: true, force: true })
          renameSync(prefix, finalPrefix)
        } catch {
          finalPrefix = prefix
        }
      }
      const cmd = claudeBinPath(finalPrefix)
      if (!existsSync(cmd)) {
        return resolve({ ok: false, version: realVer, error: '未生成 claude 可执行文件（可能包结构变了）' })
      }
      resolve({ ok: true, version: realVer, path: cmd })
    })
  })
}

// 取消正在进行的安装（Windows 上 SIGTERM 被 libuv 翻成 TerminateProcess，可立即中断）
export function cancelInstall(version: string): { ok: boolean; error?: string } {
  const v = version.trim()
  const inf = inflightInstalls.get(v)
  if (!inf) return { ok: false, error: '没有正在进行的安装任务' }
  inf.cancelled = true
  try {
    inf.proc.kill()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function uninstall(version: string): { ok: boolean; error?: string } {
  if (!VERSION_RE.test(version)) return { ok: false, error: '版本号格式非法' }
  const dir = join(versionsRoot(), version)
  if (!existsSync(dir)) return { ok: true }
  try {
    rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

