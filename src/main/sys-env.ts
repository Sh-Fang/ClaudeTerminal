import { execFile, execFileSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

// Windows 用户级环境变量（HKCU\Environment）：写用 setx、删用 reg delete（setx 删不掉）。
// 主进程 process.env 是启动时快照，新 pty 要拿最新 env 必须 snapshotCurrentEnv() 现读注册表。

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/i

function callExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

// 读 HKCU\Environment 下变量当前值；不存在返回 null。非 Windows 直接读进程 env。
export function readUserEnv(name: string): string | null {
  if (!NAME_RE.test(name)) return null
  if (!IS_WIN) return process.env[name] ?? null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true
    })
    const m = out.match(new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.*)`, 'i'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function setUserEnv(name: string, value: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  if (!IS_WIN) return false
  try {
    await callExecFile('setx', [name, value])
    envSnapshotCache = null
    return true
  } catch {
    return false
  }
}

export async function deleteUserEnv(name: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  if (!IS_WIN) return false
  try {
    await callExecFile('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'])
    envSnapshotCache = null
    return true
  } catch {
    return false
  }
}

// 注册表环境变量快照：现读 machine+user 注册表覆盖到 process.env 之上，
// PATH 按 Windows 语义拼 machine + user。
function parseRegQuery(output: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD)\s+(.*)$/)
    if (m) result[m[1]] = m[2].replace(/\s+$/, '')
  }
  return result
}

// env 键在 Windows 上大小写不敏感，需手动去重避免同时存 Path/PATH
function envGet(env: Record<string, string>, key: string): string | undefined {
  const lower = key.toLowerCase()
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k]
  return undefined
}

function envSet(env: Record<string, string>, key: string, value: string): void {
  const lower = key.toLowerCase()
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) {
      env[k] = value
      return
    }
  }
  env[key] = value
}

// REG_EXPAND_SZ 的 %VAR% 按当前 env 展开；找不到留原样（同 cmd 行为）
function expandVars(value: string, env: Record<string, string>): string {
  return value.replace(/%([^%]+)%/g, (_m, name) => envGet(env, name) ?? `%${name}%`)
}

function readRegistryEnv(path: string): Record<string, string> {
  try {
    const out = execFileSync('reg', ['query', path], { encoding: 'utf8', windowsHide: true })
    return parseRegQuery(out)
  } catch {
    return {}
  }
}

// 快照短 TTL 缓存：每次读要同步 spawn 两个 reg.exe，恢复工作区一秒内连建十几个 pty 时
// 会把主进程堵成串行等子进程；一次突发共用一份快照即可。setx/reg delete 落地后主动失效。
let envSnapshotCache: { at: number; env: Record<string, string> } | null = null
const ENV_SNAPSHOT_TTL_MS = 5000

export function snapshotCurrentEnv(): Record<string, string> {
  // 非 Windows 直接返回主进程 env（pty 走登录 shell 自行补全 PATH）
  if (!IS_WIN) return { ...(process.env as Record<string, string>) }
  if (envSnapshotCache && Date.now() - envSnapshotCache.at < ENV_SNAPSHOT_TTL_MS) {
    return { ...envSnapshotCache.env }
  }
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  const machine = readRegistryEnv(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  )
  const user = readRegistryEnv('HKCU\\Environment')

  for (const [k, v] of Object.entries(machine)) {
    if (k.toLowerCase() === 'path') continue
    envSet(env, k, expandVars(v, env))
  }
  for (const [k, v] of Object.entries(user)) {
    if (k.toLowerCase() === 'path') continue
    envSet(env, k, expandVars(v, env))
  }

  const machinePath = machine['Path'] ?? machine['PATH']
  const userPath = user['Path'] ?? user['PATH']
  const parts: string[] = []
  if (machinePath) parts.push(expandVars(machinePath, env))
  if (userPath) parts.push(expandVars(userPath, env))
  if (parts.length) envSet(env, 'Path', parts.join(';'))

  envSnapshotCache = { at: Date.now(), env }
  return { ...env }
}

export async function applyDisableAutoupdater(enabled: boolean): Promise<{
  ok: boolean
  systemWide: boolean
  message?: string
}> {
  // 非 Windows 不做系统级持久化；开关由 ipc 在 spawn pty 时注入 env 即时生效
  if (!IS_WIN) {
    return {
      ok: true,
      systemWide: false,
      message: enabled ? '已启用（app 内新建会话生效）' : '已关闭（app 内新建会话生效）'
    }
  }
  try {
    if (enabled) {
      const ok = await setUserEnv('DISABLE_AUTOUPDATER', '1')
      return { ok, systemWide: ok, message: ok ? '已写入用户环境变量' : 'setx 失败' }
    }
    // 取消时只删我们写过的，避免破坏用户原有设置
    const cur = readUserEnv('DISABLE_AUTOUPDATER')
    if (cur === null) return { ok: true, systemWide: false, message: '无需操作（未设置）' }
    const ok = await deleteUserEnv('DISABLE_AUTOUPDATER')
    return { ok, systemWide: false, message: ok ? '已从用户环境变量移除' : 'reg delete 失败' }
  } catch (e) {
    return { ok: false, systemWide: false, message: String(e) }
  }
}
