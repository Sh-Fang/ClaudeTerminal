// 标签历史：所有"打开过"的标签在这里留底，用于崩溃/强退后找回未保存的标签。
// 与 workspace.savedGroups 区别：savedGroups 是用户主动"保存分组"，需要手动触发；
// tab-history 是被动记录，开 tab 就写入，不依赖用户操作 → 真正能挡崩溃丢数据。
// 7 天自动过期：旧数据没找回价值，避免无限膨胀。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionRecord } from './workspace'
import { isSessionSource } from './session-constants'

export interface HistoryEntry {
  tabId: string // 与 live tab.id 一致；恢复后沿用同一个 id
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  openedAt: string // ISO，首次打开
  lastSeenAt: string // ISO，最近一次更新（激活/会话变化）
}

interface HistoryFile {
  version: 1
  entries: HistoryEntry[]
}

const FILE = (): string => join(app.getPath('userData'), 'tab-history.json')
const EMPTY: HistoryFile = { version: 1, entries: [] }
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function isExpired(entry: HistoryEntry, now: number): boolean {
  const t = Date.parse(entry.lastSeenAt)
  return !Number.isFinite(t) || now - t > MAX_AGE_MS
}

function normalizeSession(s: unknown): SessionRecord | null {
  if (!s || typeof s !== 'object') return null
  const r = s as Record<string, unknown>
  if (typeof r.sessionId !== 'string') return null
  return {
    sessionId: r.sessionId,
    source: isSessionSource(r.source) ? r.source : 'startup',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    userTitle: typeof r.userTitle === 'string' ? r.userTitle : undefined,
    lastTs: typeof r.lastTs === 'string' ? r.lastTs : undefined
  }
}

function normalizeEntry(e: unknown): HistoryEntry | null {
  if (!e || typeof e !== 'object') return null
  const r = e as Record<string, unknown>
  if (typeof r.tabId !== 'string' || typeof r.tabName !== 'string') return null
  if (typeof r.cwd !== 'string') return null
  const sessions = Array.isArray(r.sessions)
    ? r.sessions.map(normalizeSession).filter((s): s is SessionRecord => !!s)
    : []
  return {
    tabId: r.tabId,
    tabName: r.tabName,
    groupName: typeof r.groupName === 'string' ? r.groupName : r.cwd,
    cwd: r.cwd,
    autoLaunchCC: r.autoLaunchCC !== false,
    sessions,
    activeSessionId: typeof r.activeSessionId === 'string' ? r.activeSessionId : undefined,
    openedAt: typeof r.openedAt === 'string' ? r.openedAt : new Date().toISOString(),
    lastSeenAt: typeof r.lastSeenAt === 'string' ? r.lastSeenAt : new Date().toISOString()
  }
}

function readFile(): HistoryFile {
  try {
    const path = FILE()
    if (!existsSync(path)) return { ...EMPTY }
    const raw = readFileSync(path, 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const entries = Array.isArray(data.entries)
      ? data.entries.map(normalizeEntry).filter((x): x is HistoryEntry => !!x)
      : []
    return { version: 1, entries }
  } catch {
    return { ...EMPTY }
  }
}

function writeFileAtomic(data: HistoryFile): void {
  const path = FILE()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

// 内存缓存：upsert 是高频写（每次激活），全部走文件 IO 太慢；保留缓存 +
// 失败回退到读文件。renderer 那边也做 debounce 降低频次。
let cache: HistoryFile | null = null
function load(): HistoryFile {
  if (!cache) cache = readFile()
  return cache
}

export function listTabHistory(): HistoryEntry[] {
  const data = load()
  const now = Date.now()
  const fresh = data.entries.filter((e) => !isExpired(e, now))
  // 顺手把过期清掉
  if (fresh.length !== data.entries.length) {
    data.entries = fresh
    try { writeFileAtomic(data) } catch {}
  }
  // 按 lastSeenAt 倒序：最近用的在最前面，符合"浏览历史"体验
  return [...fresh].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export function upsertTabHistory(entry: HistoryEntry): void {
  const norm = normalizeEntry(entry)
  if (!norm) return
  const data = load()
  const idx = data.entries.findIndex((e) => e.tabId === norm.tabId)
  if (idx >= 0) {
    const old = data.entries[idx]
    // 保留首次 openedAt；其余字段以新值为准
    data.entries[idx] = { ...norm, openedAt: old.openedAt }
  } else {
    data.entries.push(norm)
  }
  try { writeFileAtomic(data) } catch {}
}

export function deleteTabHistory(tabId: string): void {
  if (typeof tabId !== 'string' || !tabId) return
  const data = load()
  const idx = data.entries.findIndex((e) => e.tabId === tabId)
  if (idx < 0) return
  data.entries.splice(idx, 1)
  try { writeFileAtomic(data) } catch {}
}

// 批量删除：renderer 按当前显示的时间桶整段清掉时用。一次写盘，比循环 delete 快。
export function deleteManyTabHistory(tabIds: string[]): void {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return
  const set = new Set(tabIds.filter((x): x is string => typeof x === 'string' && !!x))
  if (set.size === 0) return
  const data = load()
  const before = data.entries.length
  data.entries = data.entries.filter((e) => !set.has(e.tabId))
  if (data.entries.length === before) return
  try { writeFileAtomic(data) } catch {}
}

export function clearTabHistory(): void {
  const data = load()
  data.entries = []
  try { writeFileAtomic(data) } catch {}
}
