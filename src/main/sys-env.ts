import { execFile, execFileSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

// 操作 Windows 用户级环境变量（HKCU\Environment）。
// 写用 setx（会广播 WM_SETTINGCHANGE，之后**新启动**的进程从注册表读到新值）。
// 已经在跑的 Electron 主进程 process.env 是启动时的快照，setx 不会刷新它。
// 新 pty 想读到最新 env 必须用 snapshotCurrentEnv() 现读注册表。
// 删用 reg delete（setx 无法真正删除，只能写空字符串）。

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/i

function callExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

// 读 HKCU\Environment 下某个变量当前值；不存在返回 null
export function readUserEnv(name: string): string | null {
  if (!NAME_RE.test(name)) return null
  // 非 Windows 没有"用户级注册表环境变量"这一层，直接读进程 env（够 UI 回显用）
  if (!IS_WIN) return process.env[name] ?? null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true
    })
    // 行格式：    VAR_NAME    REG_SZ    value
    const m = out.match(new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.*)`, 'i'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function setUserEnv(name: string, value: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  if (!IS_WIN) return false // 非 Windows 不做系统级持久化
  try {
    await callExecFile('setx', [name, value])
    return true
  } catch {
    return false
  }
}

export async function deleteUserEnv(name: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  if (!IS_WIN) return false // 非 Windows 不做系统级持久化
  try {
    await callExecFile('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'])
    return true
  } catch {
    return false
  }
}

// —— 注册表环境变量快照 —— //
// 主进程 process.env 是启动瞬间从 CreateProcess 拿到的一份拷贝，之后不会随
// setx / 系统属性 / applyDisableAutoupdater 的写入而刷新。开新 pty 时如果直接把
// process.env 塞给 conpty，用户看到的就是老 env。这里每次现读一份注册表覆盖到
// process.env 之上，PATH 按 Windows 语义拼 machine + user。

function parseRegQuery(output: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD)\s+(.*)$/)
    if (m) result[m[1]] = m[2].replace(/\s+$/, '')
  }
  return result
}

// env 键在 Windows 上大小写不敏感（"Path" == "PATH"）；用普通对象存要手动去重，
// 否则可能同时留下 Path 和 PATH 两把，行为未定义。
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

// REG_EXPAND_SZ 里的 %VAR% 需要按当前 env 展开；找不到就留原样，跟 cmd 行为一致。
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

export function snapshotCurrentEnv(): Record<string, string> {
  // 非 Windows：没有注册表这层，且 pty 走登录 shell 会自行补全 PATH（~/.zprofile 等），
  // 这里直接返回主进程 env 即可。
  if (!IS_WIN) return { ...(process.env as Record<string, string>) }
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

  return env
}

export async function applyDisableAutoupdater(enabled: boolean): Promise<{
  ok: boolean
  systemWide: boolean
  message?: string
}> {
  // 非 Windows：不做系统级持久化。开关值存在 settings.disableAutoupdater 里，
  // 每次 spawn pty 时由 ipc 注入 DISABLE_AUTOUPDATER=1，app 内会话即时生效。
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
    // 取消：只有我们之前确实写过才删（避免破坏用户原有设置）
    const cur = readUserEnv('DISABLE_AUTOUPDATER')
    if (cur === null) return { ok: true, systemWide: false, message: '无需操作（未设置）' }
    const ok = await deleteUserEnv('DISABLE_AUTOUPDATER')
    return { ok, systemWide: false, message: ok ? '已从用户环境变量移除' : 'reg delete 失败' }
  } catch (e) {
    return { ok: false, systemWide: false, message: String(e) }
  }
}
