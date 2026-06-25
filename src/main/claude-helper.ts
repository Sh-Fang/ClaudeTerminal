import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

// 按 FEATURE-session-tabs.md §3.2：用全局唯一的 UUID 直接搜，免疫编码冲突
export function sessionExists(sessionId: string): boolean {
  if (!UUID_RE.test(sessionId)) return false
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return false
  const target = `${sessionId}.jsonl`
  try {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      if (existsSync(join(dir, target))) return true
    }
  } catch {}
  return false
}
