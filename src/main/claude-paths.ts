import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// session id 即标准 UUID；cc 的 jsonl 文件名就是 <sessionId>.jsonl
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// cc 把每个项目的会话 transcript 落在 ~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl
export const projectsRoot = (): string => join(homedir(), '.claude', 'projects')

// sessionId → jsonl 绝对路径缓存：每次全量扫 projects 目录是几百次同步 fs 调用，恢复
// 多标签时（每个会话都要查时间戳/存在性）会堵主进程。只缓存命中——miss 不缓存，因为
// cc 可能下一秒才创建该文件；命中后用前验一次存在性，文件被清理则失效重扫。
const jsonlPathCache = new Map<string, string>()

// 用全局唯一的 UUID 遍历各项目目录找 jsonl 绝对路径（免疫 cwd 编码冲突）；找不到返回 null。
export function findSessionJsonl(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null
  const cached = jsonlPathCache.get(sessionId)
  if (cached) {
    if (existsSync(cached)) return cached
    jsonlPathCache.delete(sessionId)
  }
  const root = projectsRoot()
  if (!existsSync(root)) return null
  const target = `${sessionId}.jsonl`
  try {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      const hit = join(dir, target)
      if (existsSync(hit)) {
        jsonlPathCache.set(sessionId, hit)
        return hit
      }
    }
  } catch {}
  return null
}

export function sessionExists(sessionId: string): boolean {
  return findSessionJsonl(sessionId) !== null
}
