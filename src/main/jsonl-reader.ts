import { app } from 'electron'
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
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

export interface SessionUsage {
  exists: boolean
  model?: string // 原始 id，如 claude-opus-4-8
  modelLabel?: string // 美化后，如 Opus 4.8
  ctxTokens?: number // 最近一次请求的上下文占用（input + cache）
  ctxWindow?: number // 上下文窗口（来自 cc / claude-hud 缓存，准确）
  ctxPercent?: number // 0~100
  ctxApprox?: boolean // true = transcript 兜底估算（窗口靠猜）
}

// claude-opus-4-8 → Opus 4.8 ；claude-sonnet-4-6 → Sonnet 4.6
function prettyModel(id: string): string {
  const m = /(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id
  const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return `${fam} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

// app 自己的 statusline 探针把 cc statusLine stdin 的快照按 session_id 落在这里
// （session-status/<sessionId>.json）。这是 cc 自算的 used_percentage + 真实窗口 + 模型，
// 最准，且不依赖任何第三方插件。
const STATUS_DIR = (): string => join(app.getPath('userData'), 'session-status')

interface OwnStatus {
  percent: number
  window: number
  tokens: number
  model?: string // 已是 display_name（去掉 "(...context)" 后缀），如 Opus 4.8
}

function readOwnStatus(sessionId: string): OwnStatus | null {
  try {
    const raw = readFileSync(join(STATUS_DIR(), `${sessionId}.json`), 'utf8')
    const c = JSON.parse(raw) as {
      percent?: number
      window?: number
      tokens?: number
      model?: string
    }
    if (typeof c.percent !== 'number' || !c.window) return null
    return {
      percent: Math.min(100, Math.max(0, Math.round(c.percent))),
      window: c.window,
      tokens: typeof c.tokens === 'number' ? c.tokens : 0,
      model: typeof c.model === 'string' && c.model ? c.model : undefined
    }
  } catch {
    return null
  }
}

// 最后一条「主线」（非 sidechain）assistant 的模型 id。
// 过滤 isSidechain 是为了避开子 agent / 标题生成用的小模型，拿到真正的会话模型。
function lastMainModel(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj || obj.type !== 'assistant' || obj.isSidechain === true) continue
    const m = (obj.message as { model?: string } | undefined)?.model
    if (typeof m === 'string' && m) return m
  }
  return undefined
}

// transcript 兜底估算（探针快照缺失时用，如会话刚起首帧还没落盘）：窗口只能靠启发式猜。
function estimateFromTranscript(lines: string[]): OwnStatus | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj || obj.type !== 'assistant' || obj.isSidechain === true) continue
    const u = (obj.message as { usage?: Record<string, unknown> } | undefined)?.usage
    if (!u) continue
    const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
    const used = num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens')
    if (used <= 0) continue
    const window = used > 200_000 ? 1_000_000 : 200_000
    return { percent: Math.min(100, Math.round((used / window) * 100)), window, tokens: used }
  }
  return null
}

// 模型从 transcript 取；上下文优先读 claude-hud 缓存（最准），否则 transcript 估算。
export function readSessionUsage(sessionId: string): SessionUsage {
  const path = findJsonl(sessionId)
  if (!path) return { exists: false }

  // 优先用探针快照（cc 自算，最准）；缺失才回退 transcript（按需读一次尾部）。
  const snap = readOwnStatus(sessionId)
  let lines: string[] | null = null
  const tail = (): string[] => (lines ??= readTail(path))

  const ctx = snap ?? estimateFromTranscript(tail())

  let modelLabel = snap?.model
  if (!modelLabel) {
    const id = lastMainModel(tail())
    modelLabel = id ? prettyModel(id) : undefined
  }

  return {
    exists: true,
    model: modelLabel,
    modelLabel,
    ctxTokens: ctx?.tokens,
    ctxWindow: ctx?.window,
    ctxPercent: ctx?.percent,
    ctxApprox: ctx ? !snap : undefined // 来自 transcript 兜底估算时为 true（窗口靠猜）
  }
}

// transcript 尾部按行切（去掉可能被截断的首行）
function readTail(path: string): string[] {
  const raw = tailRead(path, 64 * 1024)
  return raw ? raw.split(/\r?\n/).slice(1).filter((l) => l.length > 0) : []
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
