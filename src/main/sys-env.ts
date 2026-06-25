import { execFile, execFileSync } from 'node:child_process'

// 操作 Windows 用户级环境变量（HKCU\Environment）。
// 写用 setx（会自动广播 WM_SETTINGCHANGE，新进程立即继承）。
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
  try {
    await callExecFile('setx', [name, value])
    return true
  } catch {
    return false
  }
}

export async function deleteUserEnv(name: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  try {
    await callExecFile('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'])
    return true
  } catch {
    return false
  }
}

export async function applyDisableAutoupdater(enabled: boolean): Promise<{
  ok: boolean
  systemWide: boolean
  message?: string
}> {
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
