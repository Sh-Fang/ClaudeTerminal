import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// session id 形如标准 UUID；cc 的 jsonl 文件名就是 <sessionId>.jsonl
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// cc 把每个项目的会话 transcript 落在 ~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl
export const projectsRoot = (): string => join(homedir(), '.claude', 'projects')

// 按 FEATURE-session-tabs.md §3.2：用全局唯一的 UUID 直接搜，免疫编码冲突。
// 找到对应 jsonl 的绝对路径；找不到返回 null。
export function findSessionJsonl(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null
  const root = projectsRoot()
  if (!existsSync(root)) return null
  const target = `${sessionId}.jsonl`
  try {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      if (existsSync(join(dir, target))) return join(dir, target)
    }
  } catch {}
  return null
}

export function sessionExists(sessionId: string): boolean {
  return findSessionJsonl(sessionId) !== null
}
