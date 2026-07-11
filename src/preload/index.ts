import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume'
export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

export interface SessionRecord {
  sessionId: string
  source: SessionSource
  createdAt: string
  userTitle?: string  // 用户手动重命名，空则显示默认名「会话 N」（N 按 createdAt 排序）
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
  srcId?: string
}

export interface Workspace {
  version: 2
  groups: GroupRecord[]
  savedGroups: SavedGroupRecord[]
  activeTabId: string | null
}

export interface SessionEvent {
  tabId: string
  sessionId: string
  source: SessionSource
  cwd?: string
  ts?: string
}

export interface StateEvent {
  tabId: string
  state: TabStatus
  message?: string
  ts?: string
}

export interface HookPaths {
  ccHooksJson: string
  sessionProbeJs: string
  stateProbeJs: string
  eventsDir: string
  stateDir: string
  statusDir: string
  statuslineJs: string
  pwshProfilePs1: string
}

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-light'
export type CursorStyle = 'block' | 'underline' | 'bar'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  defaults: { cwd: string; autoLaunchCC: boolean; model: string }
  claudePath: string
  disableAutoupdater: boolean
  lastUsedCwd: string
  sidebarWidth: number
  sidebarCollapsed: boolean
  savedCollapsed: boolean
  sidebarSavedHeight: number
  statusDowngradeSec: number
  confirmCloseUnsaved: boolean
  showClaudeUsage: boolean
  showFloater: boolean
  floaterX: number | null
  floaterY: number | null
}

export interface FloaterCounts {
  done: number       // 绿点：完成 / 待查看
  attention: number  // 黄点：需要决策
  busy: number       // 蓝点：运行中
  total: number      // 全 0 时退回展示当前会话总数
}

export interface UsageWindow {
  utilization: number
  resetsAt: string | null
}
export interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayOpus?: UsageWindow | null
  sevenDaySonnet?: UsageWindow | null
  fetchedAt: number
}

// 与 src/main/clipboard.ts 的 ClipboardRead 保持一致：files / text / empty 三态
export type ClipboardRead =
  | { kind: 'files'; files: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

export interface SessionMeta {
  lastTs?: string
  mtime?: number
  exists: boolean
}

export interface SessionUsage {
  exists: boolean
  model?: string
  modelLabel?: string
  effort?: string
  ctxTokens?: number
  ctxWindow?: number
  ctxPercent?: number
  ctxApprox?: boolean
}

export interface HistoryEntry {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  openedAt: string
  lastSeenAt: string
}

export interface TermBridge {
  create(opts: { cols: number; rows: number; cwd?: string; tabId?: string; tabName?: string }): Promise<number>
  send(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  openExternal(url: string): Promise<boolean>
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  loadWorkspace(): Promise<Workspace>
  saveWorkspace(ws: Workspace): Promise<boolean>
  claudeAvailable(): Promise<boolean>
  claudeSessionExists(sessionId: string): Promise<boolean>
  claudeSessionMeta(sessionId: string): Promise<SessionMeta>
  claudeSessionUsage(sessionId: string): Promise<SessionUsage>
  claudeDetect(): Promise<string | null>
  claudeUsage(force?: boolean): Promise<ClaudeUsage>
  gitBranch(cwd: string): Promise<string | null>
  hookPaths(): Promise<HookPaths>
  pickDirectory(defaultPath?: string): Promise<string | null>
  pathExists(p: string): Promise<boolean>
  loadSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  writeClipboard(text: string): Promise<boolean>
  readClipboard(): Promise<ClipboardRead>
  applyDisableAutoupdater(enabled: boolean): Promise<{ ok: boolean; systemWide: boolean; message?: string }>
  readDisableAutoupdater(): Promise<string | null>
  winMinimize(): void
  winToggleMaximize(): void
  winClose(): void
  winConfirmClose(): void
  winIsMaximized(): Promise<boolean>
  onWindowState(cb: (s: { maximized: boolean }) => void): () => void
  onWindowCloseRequest(cb: () => void): () => void
  onData(cb: (id: number, data: string) => void): () => void
  onExit(cb: (id: number, exitCode: number) => void): () => void
  onSessionEvent(cb: (e: SessionEvent) => void): () => void
  onStateEvent(cb: (e: StateEvent) => void): () => void
  tabHistoryList(): Promise<HistoryEntry[]>
  tabHistoryUpsert(entry: HistoryEntry): Promise<boolean>
  tabHistoryDelete(tabId: string): Promise<boolean>
  tabHistoryDeleteMany(tabIds: string[]): Promise<boolean>
  tabHistoryClear(): Promise<boolean>
  // 悬浮窗
  floaterSetEnabled(on: boolean): void
  floaterPush(counts: FloaterCounts): void
  onFloaterCounts(cb: (c: FloaterCounts) => void): () => void
  floaterFocusMain(): void
  floaterHide(): void
  // 悬浮窗右键弹菜单时，菜单可能比卡片宽 → 让主进程临时把窗口放大，关菜单再缩回
  floaterResize(w: number, h: number): void
  floaterSetFocusable(on: boolean): void
  // 主窗口侧：悬浮窗被右键菜单关掉时通知一下，刷新内存里的 settings 副本
  onFloaterHidden(cb: () => void): () => void
  // 右键菜单"在此处打开 Claude Terminal"：主进程 argv 里解析出 path 后推给 renderer
  onOpenHere(cb: (path: string) => void): () => void
  // renderer 启动完成后主动拉一次：把首次启动 argv 里的 path（如果有）取走。
  // 避免"send 时 renderer 监听器还没注册"导致的丢消息。
  consumePendingOpenHere(): Promise<string[]>
}

const api: TermBridge = {
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  send: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (ws) => ipcRenderer.invoke('workspace:save', ws),
  claudeAvailable: () => ipcRenderer.invoke('claude:available'),
  claudeSessionExists: (sessionId) => ipcRenderer.invoke('claude:sessionExists', sessionId),
  claudeSessionMeta: (sessionId) => ipcRenderer.invoke('claude:sessionMeta', sessionId),
  claudeSessionUsage: (sessionId) => ipcRenderer.invoke('claude:sessionUsage', sessionId),
  claudeDetect: () => ipcRenderer.invoke('claude:detect'),
  claudeUsage: (force) => ipcRenderer.invoke('claude:usage', force),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  hookPaths: () => ipcRenderer.invoke('hooks:paths'),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('dialog:pickDirectory', defaultPath),
  pathExists: (p) => ipcRenderer.invoke('path:exists', p),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  applyDisableAutoupdater: (enabled) => ipcRenderer.invoke('sysenv:applyDisableAutoupdater', enabled),
  readDisableAutoupdater: () => ipcRenderer.invoke('sysenv:readDisableAutoupdater'),
  winMinimize: () => ipcRenderer.send('window:minimize'),
  winToggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  winClose: () => ipcRenderer.send('window:close'),
  winConfirmClose: () => ipcRenderer.send('window:closeConfirmed'),
  winIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowState: (cb) => {
    const h = (_e: IpcRendererEvent, s: { maximized: boolean }) => cb(s)
    ipcRenderer.on('window:state', h)
    return () => ipcRenderer.off('window:state', h)
  },
  onWindowCloseRequest: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('window:close-request', h)
    return () => ipcRenderer.off('window:close-request', h)
  },
  onData: (cb) => {
    const h = (_e: IpcRendererEvent, p: { id: number; data: string }) => cb(p.id, p.data)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.off('pty:data', h)
  },
  onExit: (cb) => {
    const h = (_e: IpcRendererEvent, p: { id: number; exitCode: number }) => cb(p.id, p.exitCode)
    ipcRenderer.on('pty:exit', h)
    return () => ipcRenderer.off('pty:exit', h)
  },
  onSessionEvent: (cb) => {
    const h = (_e: IpcRendererEvent, p: SessionEvent) => cb(p)
    ipcRenderer.on('session:event', h)
    return () => ipcRenderer.off('session:event', h)
  },
  onStateEvent: (cb) => {
    const h = (_e: IpcRendererEvent, p: StateEvent) => cb(p)
    ipcRenderer.on('state:event', h)
    return () => ipcRenderer.off('state:event', h)
  },
  tabHistoryList: () => ipcRenderer.invoke('tabHistory:list'),
  tabHistoryUpsert: (entry) => ipcRenderer.invoke('tabHistory:upsert', entry),
  tabHistoryDelete: (tabId) => ipcRenderer.invoke('tabHistory:delete', tabId),
  tabHistoryDeleteMany: (tabIds) => ipcRenderer.invoke('tabHistory:deleteMany', tabIds),
  tabHistoryClear: () => ipcRenderer.invoke('tabHistory:clear'),
  floaterSetEnabled: (on) => ipcRenderer.send('floater:setEnabled', !!on),
  floaterPush: (counts) => ipcRenderer.send('floater:push', counts),
  onFloaterCounts: (cb) => {
    const h = (_e: IpcRendererEvent, c: FloaterCounts) => cb(c)
    ipcRenderer.on('floater:counts', h)
    return () => ipcRenderer.off('floater:counts', h)
  },
  floaterFocusMain: () => ipcRenderer.send('floater:focusMain'),
  floaterHide: () => ipcRenderer.send('floater:hide'),
  floaterResize: (w, h) => ipcRenderer.send('floater:resize', { w, h }),
  floaterSetFocusable: (on) => ipcRenderer.send('floater:setFocusable', !!on),
  onFloaterHidden: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('floater:hidden', h)
    return () => ipcRenderer.off('floater:hidden', h)
  },
  onOpenHere: (cb) => {
    const h = (_e: IpcRendererEvent, p: string) => cb(p)
    ipcRenderer.on('app:openHere', h)
    return () => ipcRenderer.off('app:openHere', h)
  },
  consumePendingOpenHere: () => ipcRenderer.invoke('app:consumePendingOpenHere')
}

contextBridge.exposeInMainWorld('term', api)
