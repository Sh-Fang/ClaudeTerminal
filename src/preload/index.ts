import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume'
export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

export interface SessionRecord {
  sessionId: string
  source: SessionSource
  createdAt: string
  aiTitle?: string
  userTitle?: string  // 用户手动重命名（优先于 aiTitle 显示）
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
  recordSessionPs1: string
  recordStatePs1: string
  eventsDir: string
  stateDir: string
}

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-light'
export type CursorStyle = 'block' | 'underline' | 'bar'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  defaults: { cwd: string; autoLaunchCC: boolean }
  claudePath: string
  disableAutoupdater: boolean
  lastUsedCwd: string
  sidebarWidth: number
  sidebarCollapsed: boolean
}

// 与 src/main/clipboard.ts 的 ClipboardRead 保持一致：files / text / empty 三态
export type ClipboardRead =
  | { kind: 'files'; files: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

export interface SessionMeta {
  aiTitle?: string
  lastTs?: string
  lastPrompt?: string
  mtime?: number
  exists: boolean
}

export interface TermBridge {
  create(opts: { cols: number; rows: number; cwd?: string; tabId?: string }): Promise<number>
  send(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  openExternal(url: string): Promise<boolean>
  loadWorkspace(): Promise<Workspace>
  saveWorkspace(ws: Workspace): Promise<boolean>
  claudeAvailable(): Promise<boolean>
  claudeSessionExists(sessionId: string): Promise<boolean>
  claudeSessionMeta(sessionId: string): Promise<SessionMeta>
  claudeDetect(): Promise<string | null>
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
}

const api: TermBridge = {
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  send: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (ws) => ipcRenderer.invoke('workspace:save', ws),
  claudeAvailable: () => ipcRenderer.invoke('claude:available'),
  claudeSessionExists: (sessionId) => ipcRenderer.invoke('claude:sessionExists', sessionId),
  claudeSessionMeta: (sessionId) => ipcRenderer.invoke('claude:sessionMeta', sessionId),
  claudeDetect: () => ipcRenderer.invoke('claude:detect'),
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
  }
}

contextBridge.exposeInMainWorld('term', api)
