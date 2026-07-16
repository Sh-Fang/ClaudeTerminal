import { app } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 每个版本装到 <userData>/cc-versions/<version>/，用 `npm install -g pkg@ver --prefix=<dir>`
// 隔离；Windows 下 prefix 根目录直接有 claude.cmd / claude.ps1 / claude 及 node_modules。
// 切换 = 把 settings.claudePath 指向对应目录的 claude.cmd，走既有 pty 注入 env 的路径。
// 登录态在 ~/.claude/ 全局共享，切版本不用重登。

export const CC_PACKAGE = '@anthropic-ai/claude-code'
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

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

// 版本目录名允许 semver 常见字符；挡掉 .. / 斜杠等目录穿越
const VERSION_RE = /^[A-Za-z0-9._+-]+$/

// 简易 semver 比较：主/次/修订取数字比较，pre-release 视为更小（无 pre > 有 pre）
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
  if (!ap) return 1   // 1.0.0 > 1.0.0-beta
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

// where.exe npm.cmd 找到系统 npm；结果缓存到进程生命周期
let cachedNpm: string | null | undefined
export function detectNpm(): string | null {
  if (cachedNpm !== undefined) return cachedNpm
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

// Node 20+ 因 CVE-2024-27980 禁止直接 spawn .cmd（甩 EINVAL）。绕过：读 npm.cmd 所在
// 目录里的 node.exe + node_modules/npm/bin/npm-cli.js，直接用 node 跑，彻底避开 .cmd。
// 兼容 nvm4w / 官方 msi / winget 布局，也可退化到 where node 拿 node.exe 再拼 cli 路径。
interface NpmInvocation { node: string; cli: string }
let cachedInvoke: NpmInvocation | null | undefined
function resolveNpmInvocation(): NpmInvocation | null {
  if (cachedInvoke !== undefined) return cachedInvoke
  const npmCmd = detectNpm()
  if (!npmCmd) { cachedInvoke = null; return null }
  const dir = dirname(npmCmd)
  const candidates: Array<{ node: string; cli: string }> = [
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') },
    // nvm4w 的 npm.cmd 有时是 shim，真正 npm 在同层 node_modules
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'lib', 'npm.js') }
  ]
  for (const c of candidates) {
    if (existsSync(c.node) && existsSync(c.cli)) { cachedInvoke = c; return c }
  }
  // 兜底：where node.exe，再回来拼 cli
  try {
    const out = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true })
    const nodeExe = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l))
    if (nodeExe) {
      const cli = join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(cli)) { cachedInvoke = { node: nodeExe, cli }; return cachedInvoke }
    }
  } catch {}
  cachedInvoke = null
  return null
}

// registry URL 白名单校验：http(s) + 常规 URL 字符，挡掉 shell 元字符（虽然我们不走 shell，
// 但传给 npm 的 --registry 也可能被 npm 内部再解析）
const REGISTRY_RE = /^https?:\/\/[A-Za-z0-9._~\-/:@%?&=+]+$/
function safeRegistry(reg: string): string {
  const v = (reg || '').trim() || DEFAULT_NPM_REGISTRY
  return REGISTRY_RE.test(v) ? v : DEFAULT_NPM_REGISTRY
}

function readPkgVersion(dir: string): string | null {
  try {
    const p = join(dir, 'node_modules', CC_PACKAGE, 'package.json')
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
    const cmd = join(dir, 'claude.cmd')
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

// 从任意 claude 可执行路径反查版本号：
// - 托管路径：<userData>/cc-versions/<ver>/claude.cmd → 顺着找 node_modules/@anthropic-ai/claude-code/package.json
// - 系统 npm 全局：C:\...\node_modules\@anthropic-ai\claude-code\cli.js 或旁边的 claude.cmd
// 找不到返回 null，UI 显示「未知版本」即可
export function versionFromPath(claudePath: string): string | null {
  if (!claudePath) return null
  // 优先当作 <prefix>/claude.cmd 处理
  const prefix = dirname(claudePath)
  const v1 = readPkgVersion(prefix)
  if (v1) return v1
  // 或者路径直接指向 cli.js —— 向上找到 @anthropic-ai/claude-code/package.json
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
  if (!inv) throw new Error('未找到 npm / node.exe，请检查 Node.js 安装')
  const reg = safeRegistry(registry)
  return new Promise((resolve, reject) => {
    execFile(
      inv.node,
      [inv.cli, 'view', CC_PACKAGE, 'versions', '--json', `--registry=${reg}`],
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

// 记录在跑的安装进程，供 cancel 调用；key = version，value = spawned ChildProcess + cleanup 路径
interface InflightInstall {
  proc: ReturnType<typeof spawn>
  prefix: string
  createdDir: boolean  // 目录是本次安装才建的 → 取消/失败时可整目录清理
  cancelled: boolean
}
const inflightInstalls = new Map<string, InflightInstall>()

// ANSI 转义序列剥离：npm progress 会用 CSI 序列做游标控制，直接展示会有乱码
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
  if (!inv) return Promise.resolve({ ok: false, version: ver, error: '未找到 npm / node.exe' })
  const reg = safeRegistry(registry)
  // 目录名先用请求的 ver；latest 用临时名，装完读 package.json 里真实版本改名
  const useTmp = ver === 'latest'
  const dirName = useTmp ? `_pending_${Date.now()}` : ver
  const prefix = join(versionsRoot(), dirName)
  const createdDir = !existsSync(prefix)
  if (createdDir) mkdirSync(prefix, { recursive: true })
  const args = [
    inv.cli,
    'install', '-g', `${CC_PACKAGE}@${ver}`,
    `--prefix=${prefix}`,
    `--registry=${reg}`,
    '--no-audit', '--no-fund', '--no-package-lock'
  ]
  onPhase('准备…')
  return new Promise((resolve) => {
    const p = spawn(inv.node, args, { windowsHide: true })
    const state: InflightInstall = { proc: p, prefix, createdDir, cancelled: false }
    inflightInstalls.set(ver, state)
    const cleanupOnFail = (): void => {
      // 只清理本次新建的目录；用户之前已装的同版本不能被误删（虽然 has(ver) 已挡在前面，双保险）
      if (state.createdDir) { try { rmSync(prefix, { recursive: true, force: true }) } catch {} }
    }
    // 从 npm stdout/stderr 抽取最新一行短语作为 phase：剥 ANSI + 拆行 + 去空
    // npm progress 走 stderr（TTY spinner 行）；install summary 走 stdout
    let lastPhaseSent = ''
    let lastSendTs = 0
    const handleChunk = (buf: Buffer): void => {
      const clean = buf.toString().replace(ANSI_RE, '').replace(/\r/g, '\n')
      const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 200)
      if (!lines.length) return
      const line = lines[lines.length - 1]
      if (line === lastPhaseSent) return
      const now = Date.now()
      if (now - lastSendTs < 250) return  // 节流 250ms
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
      const cmd = join(finalPrefix, 'claude.cmd')
      if (!existsSync(cmd)) {
        return resolve({ ok: false, version: realVer, error: '未生成 claude.cmd（可能包结构变了）' })
      }
      resolve({ ok: true, version: realVer, path: cmd })
    })
  })
}

// 取消正在进行的安装：kill node 子进程；返回是否找到并杀掉了对应进程
export function cancelInstall(version: string): { ok: boolean; error?: string } {
  const v = version.trim()
  const inf = inflightInstalls.get(v)
  if (!inf) return { ok: false, error: '没有正在进行的安装任务' }
  inf.cancelled = true
  try {
    // Windows 上 SIGTERM 由 libuv 翻成 TerminateProcess，能立刻中断 node/npm
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

