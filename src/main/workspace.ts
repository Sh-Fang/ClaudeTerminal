import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isSessionSource,
  isTabStatus,
  type SessionSource,
  type TabStatus
} from './session-constants'

export type { SessionSource, TabStatus }

export interface SessionRecord {
  sessionId: string
  source: SessionSource
  createdAt: string
  userTitle?: string // 用户手动重命名，空则默认「会话 N」——需持久化，否则保存的分组重载后丢失
  lastTs?: string
}

export interface TabRecord {
  id: string
  name: string
  sessions: SessionRecord[]
  activeSessionId?: string
  autoLaunchCC?: boolean
  status?: TabStatus
  note?: string
}

export interface GroupRecord {
  id: string
  name: string
  cwd: string
  collapsed?: boolean
  tabs: TabRecord[]
}

export interface SavedGroupRecord {
  id: string
  name: string
  cwd: string
  savedAt: string
  tabCount: number
  snapshot: GroupRecord
  srcId?: string // 原始 group.id，用于「同组覆盖」
}

// 保存整个工作区：当前 groups + activeTabId 完整快照，用于一键恢复整套开发上下文
export interface SavedWorkspaceRecord {
  id: string
  name: string
  savedAt: string
  groupCount: number
  tabCount: number
  snapshot: {
    groups: GroupRecord[]
    activeTabId: string | null
  }
}

export interface Workspace {
  version: 2
  groups: GroupRecord[]
  savedGroups: SavedGroupRecord[]
  savedWorkspaces: SavedWorkspaceRecord[]
  activeTabId: string | null
}

const FILE = () => join(app.getPath('userData'), 'workspace.json')

const EMPTY: Workspace = { version: 2, groups: [], savedGroups: [], savedWorkspaces: [], activeTabId: null }

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

function normalizeTab(t: unknown): TabRecord | null {
  if (!t || typeof t !== 'object') return null
  const r = t as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null

  let sessions: SessionRecord[] = []
  if (Array.isArray(r.sessions)) {
    sessions = r.sessions.map(normalizeSession).filter((s): s is SessionRecord => !!s)
  } else if (typeof r.sessionId === 'string') {
    // M5-A 老格式：迁移
    sessions = [{ sessionId: r.sessionId, source: 'startup', createdAt: new Date().toISOString() }]
  }

  let activeSessionId: string | undefined
  if (
    typeof r.activeSessionId === 'string' &&
    sessions.some((s) => s.sessionId === r.activeSessionId)
  ) {
    activeSessionId = r.activeSessionId
  } else if (typeof r.activeSessionId === 'string') {
    activeSessionId = r.activeSessionId
  } else if (sessions.length > 0) {
    activeSessionId = sessions[sessions.length - 1].sessionId
  }

  const status = isTabStatus(r.status) ? r.status : undefined

  return {
    id: r.id,
    name: r.name,
    sessions,
    activeSessionId,
    autoLaunchCC: typeof r.autoLaunchCC === 'boolean' ? r.autoLaunchCC : true,
    status,
    note: typeof r.note === 'string' ? r.note : undefined
  }
}

function normalizeGroup(g: unknown): GroupRecord | null {
  if (!g || typeof g !== 'object') return null
  const r = g as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.cwd !== 'string') return null
  const tabs = Array.isArray(r.tabs)
    ? r.tabs.map(normalizeTab).filter((t): t is TabRecord => !!t)
    : []
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    collapsed: r.collapsed === true,
    tabs
  }
}

function normalizeSaved(s: unknown): SavedGroupRecord | null {
  if (!s || typeof s !== 'object') return null
  const r = s as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.cwd !== 'string') return null
  const snap = normalizeGroup(r.snapshot)
  if (!snap) return null
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : new Date().toISOString(),
    tabCount: typeof r.tabCount === 'number' ? r.tabCount : snap.tabs.length,
    snapshot: snap,
    srcId: typeof r.srcId === 'string' ? r.srcId : undefined
  }
}

function normalizeSavedWorkspace(s: unknown): SavedWorkspaceRecord | null {
  if (!s || typeof s !== 'object') return null
  const r = s as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  const rawSnap = (r.snapshot ?? {}) as Record<string, unknown>
  const groups = Array.isArray(rawSnap.groups)
    ? rawSnap.groups.map(normalizeGroup).filter((g): g is GroupRecord => !!g)
    : []
  const activeTabId = typeof rawSnap.activeTabId === 'string' ? rawSnap.activeTabId : null
  const tabCount = groups.reduce((n, g) => n + g.tabs.length, 0)
  return {
    id: r.id,
    name: r.name,
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : new Date().toISOString(),
    groupCount: typeof r.groupCount === 'number' ? r.groupCount : groups.length,
    tabCount: typeof r.tabCount === 'number' ? r.tabCount : tabCount,
    snapshot: { groups, activeTabId }
  }
}

function migrateV1(data: Record<string, unknown>): Workspace {
  // v1: { version:1, tabs:[{id,name,cwd,...}], activeTabId }
  const v1Tabs = Array.isArray(data.tabs) ? data.tabs : []
  // 按 cwd 聚合：同 cwd → 同组
  const byCwd = new Map<string, { name: string; tabs: TabRecord[] }>()
  for (const raw of v1Tabs) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const cwd = typeof r.cwd === 'string' ? r.cwd : ''
    const tab = normalizeTab(r)
    if (!tab) continue
    const key = cwd
    if (!byCwd.has(key)) byCwd.set(key, { name: groupNameFromCwd(cwd), tabs: [] })
    byCwd.get(key)!.tabs.push(tab)
  }
  const groups: GroupRecord[] = []
  for (const [cwd, info] of byCwd) {
    groups.push({
      id: `g_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
      name: info.name,
      cwd,
      collapsed: false,
      tabs: info.tabs
    })
  }
  return {
    version: 2,
    groups,
    savedGroups: [],
    savedWorkspaces: [],
    activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null
  }
}

function groupNameFromCwd(cwd: string): string {
  if (!cwd) return '默认'
  const segs = cwd.replace(/[/\\]+$/, '').split(/[\\/]/).filter(Boolean)
  return segs[segs.length - 1] || cwd
}

export function loadWorkspace(): Workspace {
  try {
    const path = FILE()
    if (!existsSync(path)) return EMPTY
    const raw = readFileSync(path, 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const version = typeof data.version === 'number' ? data.version : 1
    if (version === 1) {
      // 备份后迁移
      try { writeFileSync(`${path}.v1.bak`, raw, 'utf8') } catch {}
      return migrateV1(data)
    }
    const groups = Array.isArray(data.groups)
      ? data.groups.map(normalizeGroup).filter((g): g is GroupRecord => !!g)
      : []
    const savedGroups = Array.isArray(data.savedGroups)
      ? data.savedGroups.map(normalizeSaved).filter((s): s is SavedGroupRecord => !!s)
      : []
    const savedWorkspaces = Array.isArray(data.savedWorkspaces)
      ? data.savedWorkspaces.map(normalizeSavedWorkspace).filter((s): s is SavedWorkspaceRecord => !!s)
      : []
    return {
      version: 2,
      groups,
      savedGroups,
      savedWorkspaces,
      activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : null
    }
  } catch {
    return EMPTY
  }
}

export function saveWorkspace(ws: Workspace): void {
  const path = FILE()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(ws, null, 2), 'utf8')
  renameSync(tmp, path)
}
