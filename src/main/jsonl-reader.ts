import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SessionMeta {
  exists: boolean
  aiTitle?: string
  lastTs?: string
  lastPrompt?: string
  mtime?: number
}

const ROOT = () => join(homedir(), '.claude', 'projects')

function findJsonl(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null
  const root = ROOT()
  if (!existsSync(root)) return null
  const target = `${sessionId}.jsonl`
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, target)
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}

// 从文件尾读最多 N 字节
function tailRead(path: string, maxBytes = 40 * 1024): string {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const len = Math.min(size, maxBytes)
    const start = size - len
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
}

function safeParse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
}

export function readSessionMeta(sessionId: string): SessionMeta {
  const path = findJsonl(sessionId)
  if (!path) return { exists: false }

  let mtime: number | undefined
  try { mtime = statSync(path).mtimeMs } catch {}

  const raw = tailRead(path)
  if (!raw) return { exists: true, mtime }

  // 末尾可能切到行中间，丢掉首段
  const lines = raw.split(/\r?\n/).slice(1).filter((l) => l.length > 0)

  let aiTitle: string | undefined
  let lastPrompt: string | undefined
  let lastTs: string | undefined

  // 倒序遍历找最新；ai-title / last-prompt 取最后一次出现；timestamp 取最新 user/assistant
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj) continue
    const type = typeof obj.type === 'string' ? obj.type : ''

    if (!aiTitle && type === 'ai-title' && typeof obj.aiTitle === 'string') {
      aiTitle = obj.aiTitle
    } else if (!lastPrompt && type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
      lastPrompt = obj.lastPrompt
    } else if (!lastTs && (type === 'user' || type === 'assistant') && typeof obj.timestamp === 'string') {
      // 排除非真实对话条目：tool_result 数组、command 包装、compact 提示
      if (isRealMessage(obj)) lastTs = obj.timestamp
    }

    if (aiTitle && lastTs && lastPrompt) break
  }

  return { exists: true, aiTitle, lastPrompt, lastTs, mtime }
}

function isRealMessage(obj: Record<string, unknown>): boolean {
  // 简单过滤：message 是 array 通常是 tool_result；compact boundary
  const msg = obj.message as { content?: unknown; role?: unknown } | undefined
  if (msg && Array.isArray(msg.content)) {
    // tool_result 段
    const first = msg.content[0] as Record<string, unknown> | undefined
    if (first && (first.type === 'tool_result' || first.type === 'tool_use')) return false
  }
  if (obj.isCompactSummary === true) return false
  if (typeof obj.content === 'string' && /<command-name|<local-command|This session is being continued/.test(obj.content)) {
    return false
  }
  return true
}
