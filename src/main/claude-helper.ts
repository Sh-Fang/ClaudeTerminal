import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export { sessionExists } from './claude-paths'

const IS_WIN = process.platform === 'win32'

// 用登录+交互 shell 解析命令候选路径（macOS GUI 进程 PATH 极简，-lic 让 rc 文件里的 PATH 生效）
function whichAllViaLoginShell(name: string): string[] {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-lic', `which -a ${name} 2>/dev/null || command -v ${name}`], {
      encoding: 'utf8'
    })
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/') && existsSync(l))
  } catch {
    return []
  }
}

let cachedAvailable: boolean | null = null

export function isClaudeAvailable(): boolean {
  if (cachedAvailable != null) return cachedAvailable
  if (!IS_WIN) {
    cachedAvailable = whichAllViaLoginShell('claude').length > 0
    return cachedAvailable
  }
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
    cachedAvailable = out.split(/\r?\n/).some((l) => l.trim().length > 0)
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

// 返回 claude 可执行路径；找不到返回 null。
// Windows 按扩展名优先级挑：.cmd > .ps1 > .exe > 其他；类 Unix 取 which 首条。
export function detectClaudePath(): string | null {
  if (!IS_WIN) {
    const cands = whichAllViaLoginShell('claude')
    return cands[0] ?? null
  }
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
    const cands = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (cands.length === 0) return null
    const score = (p: string): number => {
      const ext = p.toLowerCase().match(/\.[a-z]+$/)?.[0] ?? ''
      if (ext === '.cmd') return 3
      if (ext === '.ps1') return 2
      if (ext === '.exe') return 1
      return 0
    }
    cands.sort((a, b) => score(b) - score(a))
    return cands[0]
  } catch {
    return null
  }
}
