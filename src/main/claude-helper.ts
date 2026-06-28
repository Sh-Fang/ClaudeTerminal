import { execFileSync } from 'node:child_process'

export { sessionExists } from './claude-paths'

let cachedAvailable: boolean | null = null

export function isClaudeAvailable(): boolean {
  if (cachedAvailable != null) return cachedAvailable
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
    cachedAvailable = out.split(/\r?\n/).some((l) => l.trim().length > 0)
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

// 按优先级返回 claude 可执行路径：.cmd > .ps1 > .exe > 其他；找不到返回 null
export function detectClaudePath(): string | null {
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
