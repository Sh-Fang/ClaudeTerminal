import { app } from 'electron'
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSessionJsonl as findJsonl } from './claude-paths'
import { prettyModelLabel, withContextSuffix } from '../shared/claude-models'

export interface SessionMeta {
  exists: boolean
  lastTs?: string
  mtime?: number
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

  let lastTs: string | undefined

  // 倒序找最新的真实 user/assistant timestamp（排除 tool_result/command 包装/compact 提示）
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj) continue
    const type = typeof obj.type === 'string' ? obj.type : ''
    if ((type === 'user' || type === 'assistant') && typeof obj.timestamp === 'string') {
      if (isRealMessage(obj)) { lastTs = obj.timestamp; break }
    }
  }

  return { exists: true, lastTs, mtime }
}

export interface SessionUsage {
  exists: boolean
  model?: string // 原始 id，如 claude-opus-4-8
  modelLabel?: string // 美化后，如 Opus 4.8
  effort?: string // 当前思考强度 low/medium/high/xhigh/max；模型不支持时为空
  ctxTokens?: number // 最近一次请求的上下文占用（input + cache）
  ctxWindow?: number // 上下文窗口（来自 cc / claude-hud 缓存，准确）
  ctxPercent?: number // 0~100
  ctxApprox?: boolean // true = transcript 兜底估算（窗口靠猜）
}

// claude-opus-4-8 → Opus 4.8 ；claude-sonnet-4-6 → Sonnet 4.6（与渲染层共用同一套推导）
const prettyModel = prettyModelLabel

// statusline 探针落的快照（session-status/<sessionId>.json）：cc 自算的百分比/窗口/模型，最准
const STATUS_DIR = (): string => join(app.getPath('userData'), 'session-status')

interface OwnStatus {
  percent: number
  window: number
  tokens: number
  modelId?: string
  modelLabel?: string
  model?: string // 旧版字段：已是 display_name
  effort?: string // low/medium/high/xhigh/max；模型不支持 effort 时为空
}

function readOwnStatus(sessionId: string): OwnStatus | null {
  try {
    const raw = readFileSync(join(STATUS_DIR(), `${sessionId}.json`), 'utf8')
    const c = JSON.parse(raw) as {
      percent?: number
      window?: number
      tokens?: number
      modelId?: string
      modelLabel?: string
      model?: string
      effort?: string
    }
    if (typeof c.percent !== 'number' || !c.window) return null
    return {
      percent: Math.min(100, Math.max(0, Math.round(c.percent))),
      window: c.window,
      tokens: typeof c.tokens === 'number' ? c.tokens : 0,
      modelId: typeof c.modelId === 'string' && c.modelId ? c.modelId : undefined,
      modelLabel: typeof c.modelLabel === 'string' && c.modelLabel ? c.modelLabel : undefined,
      model: typeof c.model === 'string' && c.model ? c.model : undefined,
      effort: typeof c.effort === 'string' && c.effort ? c.effort : undefined
    }
  } catch {
    return null
  }
}

// 最后一条主线 assistant 的模型 id（过滤 isSidechain，避开子 agent 小模型）
function lastMainModel(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj || obj.type !== 'assistant' || obj.isSidechain === true) continue
    const m = (obj.message as { model?: string } | undefined)?.model
    if (typeof m === 'string' && m) return m
  }
  return undefined
}

// transcript 兜底估算（探针快照缺失时）：窗口靠启发式猜
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

// 优先用探针快照（cc 自算，最准）；缺失才回退 transcript 尾部估算。
export function readSessionUsage(sessionId: string): SessionUsage {
  const path = findJsonl(sessionId)
  if (!path) return { exists: false }

  const snap = readOwnStatus(sessionId)
  let lines: string[] | null = null
  const tail = (): string[] => (lines ??= readTail(path))

  const ctx = snap ?? estimateFromTranscript(tail())

  const modelId = snap?.modelId || lastMainModel(tail())
  const rawLabel = snap?.modelLabel || snap?.model || (modelId ? prettyModel(modelId) : undefined)
  // cc 对 1M 变体报的 display_name 与标准版相同，补后缀才能看出当前在哪个上下文档位
  const modelLabel = rawLabel && modelId ? withContextSuffix(rawLabel, modelId) : rawLabel

  return {
    exists: true,
    model: modelId,
    modelLabel,
    effort: snap?.effort, // 仅探针快照有
    ctxTokens: ctx?.tokens,
    ctxWindow: ctx?.window,
    ctxPercent: ctx?.percent,
    ctxApprox: ctx ? !snap : undefined // transcript 兜底估算时为 true
  }
}

// transcript 尾部按行切（去掉可能被截断的首行）
function readTail(path: string): string[] {
  const raw = tailRead(path, 64 * 1024)
  return raw ? raw.split(/\r?\n/).slice(1).filter((l) => l.length > 0) : []
}

function isRealMessage(obj: Record<string, unknown>): boolean {
  const msg = obj.message as { content?: unknown; role?: unknown } | undefined
  if (msg && Array.isArray(msg.content)) {
    const first = msg.content[0] as Record<string, unknown> | undefined
    if (first && (first.type === 'tool_result' || first.type === 'tool_use')) return false
  }
  if (obj.isCompactSummary === true) return false
  if (typeof obj.content === 'string' && /<command-name|<local-command|This session is being continued/.test(obj.content)) {
    return false
  }
  return true
}
