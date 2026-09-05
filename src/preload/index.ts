import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LearnedModel } from '../shared/claude-models'
import type {
  ClaudeAccountDetail,
  ClaudeAccountResult,
  ClaudeAccountsSnapshot,
  SaveClaudeAccountInput
} from '../shared/claude-accounts'
import type { UpdateActionResult, UpdateCheckResult, UpdateEvent } from '../shared/update'

export type {
  LearnedModel,
  ClaudeAccountDetail,
  ClaudeAccountResult,
  ClaudeAccountsSnapshot,
  SaveClaudeAccountInput,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateEvent
}

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume'
export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

export interface SessionRecord {
  sessionId: string
  source: SessionSource
  createdAt: string
  userTitle?: string  // 用户手动重命名；空则显示默认名「会话 N」
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
  memo?: string
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
  lastRestoredAt?: string
  tabCount: number
  snapshot: GroupRecord
  srcId?: string
}

export interface SavedWorkspaceRecord {
  id: string
  name: string
  savedAt: string
  lastRestoredAt?: string
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
  zshProfile: string
  bashProfile: string
}

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-dark'
export type AppTheme = 'light' | 'dark'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type UsageStyle = 'bar' | 'ring'
export type CloseBehavior = 'quit' | 'tray'
export type TabBarMode = 'vertical' | 'horizontal'
export type AppLanguage = 'zh' | 'en'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  appTheme: AppTheme
  defaults: { cwd: string; autoLaunchCC: boolean; model: string }
  claudePath: string
  npmRegistry: string
  npmMirrorEnabled: boolean
  disableAutoupdater: boolean
  lastUsedCwd: string
  sidebarWidth: number
  sidebarCollapsed: boolean
  savedCollapsed: boolean
  sidebarSavedHeight: number
  statusDowngradeSec: number
  showClaudeUsage: boolean
  usageStyle: UsageStyle
  closeBehavior: CloseBehavior
  showFloater: boolean
  floaterX: number | null
  floaterY: number | null
  tabBarMode: TabBarMode
  language: AppLanguage
  learnedModels: LearnedModel[]
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
  scopeLabel?: string // 周额度按模型拆分时的模型名（如 'Fable'）；无 = 账号级总额度
}
export interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayModel?: UsageWindow | null // 模型级周额度（如 Fable），用于 hover 展示
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

export interface InstalledCcVersion {
  version: string
  path: string
  installedAt: number
  active: boolean
}
export interface CcInstallResult {
  ok: boolean
  version: string
  path?: string
  error?: string
}
export interface CcRemoteResult {
  ok: boolean
  versions: string[]
  error?: string
}
export interface HistoryEntry {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  memo?: string
  openedAt: string
  lastSeenAt: string
}

export interface TermBridge {
  platform: NodeJS.Platform  // 'win32' | 'darwin' | ...：渲染层据此切换 shell 引号/窗口按钮
  create(opts: { cols: number; rows: number; cwd?: string; tabId?: string; tabName?: string; freshEnv?: boolean }): Promise<number>
  send(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  // 杀掉并等待进程真正退出（重新加载标签用）；超时也会 resolve
  killWait(id: number): Promise<boolean>
  openExternal(url: string): Promise<boolean>
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  loadWorkspace(): Promise<Workspace>
  saveWorkspace(ws: Workspace): Promise<boolean>
  claudeAvailable(): Promise<boolean>
  claudeSessionExists(sessionId: string): Promise<boolean>
  claudeSessionMeta(sessionId: string): Promise<SessionMeta>
  claudeSessionUsage(sessionId: string): Promise<SessionUsage>
  claudeDetect(): Promise<string | null>
  appVersion(): Promise<string>
  // npm 镜像测速：返回响应头到达耗时 ms；超时/连不上返回 -1
  npmPing(url: string): Promise<number>
  ccListInstalled(): Promise<InstalledCcVersion[]>
  ccListRemote(): Promise<CcRemoteResult>
  ccInstall(version: string): Promise<CcInstallResult>
  ccInstallCancel(version: string): Promise<{ ok: boolean; error?: string }>
  ccUninstall(version: string): Promise<{ ok: boolean; error?: string }>
  ccCurrentVersion(): Promise<string | null>
  onCcInstallPhase(cb: (p: { version: string; phase: string }) => void): () => void
  claudeUsage(force?: boolean): Promise<ClaudeUsage>
  claudeAccountsLoad(): Promise<ClaudeAccountResult<ClaudeAccountsSnapshot>>
  claudeAccountGet(id: string | null): Promise<ClaudeAccountResult<ClaudeAccountDetail>>
  claudeAccountSave(input: SaveClaudeAccountInput): Promise<ClaudeAccountResult<ClaudeAccountsSnapshot>>
  claudeAccountActivate(id: string): Promise<ClaudeAccountResult<ClaudeAccountsSnapshot>>
  claudeAccountDelete(id: string): Promise<ClaudeAccountResult<ClaudeAccountsSnapshot>>
  onClaudeAccountsChanged(cb: () => void): () => void
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
  checkUpdate(): Promise<UpdateCheckResult>
  downloadUpdate(): Promise<UpdateActionResult>
  deferUpdate(): Promise<boolean>
  getAutoLaunch(): Promise<boolean>
  setAutoLaunch(enabled: boolean): Promise<{ ok: boolean }>
  installUpdate(): Promise<UpdateActionResult>
  onUpdateEvent(cb: (e: UpdateEvent) => void): () => void
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
  tabHistoryUpsertMany(entries: HistoryEntry[]): Promise<boolean>
  tabHistoryDelete(tabId: string): Promise<boolean>
  tabHistoryDeleteMany(tabIds: string[]): Promise<boolean>
  tabHistoryClear(): Promise<boolean>
  // 悬浮窗
  floaterSetEnabled(on: boolean): void
  floaterPush(counts: FloaterCounts): void
  onFloaterCounts(cb: (c: FloaterCounts) => void): () => void
  floaterFocusMain(): void
  floaterHide(): void
  floaterSetFocusable(on: boolean): void
  floaterMoveTo(x: number, y: number): void
  floaterDragState(on: boolean): void
  // 悬浮窗被右键菜单关掉时通知主窗口刷新内存 settings
  onFloaterHidden(cb: () => void): () => void
  // 右键菜单"在此处打开"：主进程从 argv 解析 path 后推给 renderer
  onOpenHere(cb: (path: string) => void): () => void
  // renderer 启动完成后主动拉取首次启动 argv 里的 path（避免 send 早于监听器注册而丢消息）
  consumePendingOpenHere(): Promise<string[]>
  // 需要整体重启的场景（如语言切换）
  relaunchApp(): void

  // 多窗口 / 标签跨窗口迁移
  windowId(): Promise<number>
  // 渲染层认领/释放 tabId：主进程按此路由 PTY 数据与 hook 事件
  tabClaim(tabId: string): void
  tabRelease(tabId: string): void
  // targetWindowId 有值 = 迁到该窗口（拖回）；无值 = 在屏幕坐标处开新窗（拖出）
  tabMoveToWindow(opts: {
    tabId: string
    targetWindowId?: number
    screenX?: number
    screenY?: number
  }): Promise<{ ok: boolean; error?: string }>
  // 源窗口 serialize 前调：PTY 输出进主进程暂存队列（迁移期间不丢字节）
  ptyHold(ptyId: number): Promise<void>
  onTabExportRequest(cb: (req: { reqId: string; tabId: string }) => void): () => void
  tabExportReply(reqId: string, payload: TabTransferPayload | null): void
  onTabImport(cb: (payload: TabTransferPayload) => void): () => void
  tabImportDone(tabId: string, ptyId: number | null): void
  // 副窗口渲染层就绪上报，主进程据此开始 import
  secondaryReady(): void
  // 其他窗口落盘引发的跨窗口同步
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onWorkspaceChanged(cb: () => void): () => void
}

// 跨窗口标签迁移的传输包：源窗口打包 → 主进程转交 → 目标窗口重建
export interface TabTransferPayload {
  tab: {
    id: string
    name: string
    cwd: string
    sessions: SessionRecord[]
    activeSessionId?: string
    autoLaunchCC: boolean
    status: string
    note?: string
    memo?: string
    dirty: boolean
    ccActive: boolean
  }
  group: { id: string; name: string; cwd: string }
  ptyId: number | null
  // xterm 缓冲区的 ANSI 序列化快照（@xterm/addon-serialize）
  buffer: string
}

const api: TermBridge = {
  platform: process.platform,
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  send: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  killWait: (id) => ipcRenderer.invoke('pty:killWait', { id }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (ws) => ipcRenderer.invoke('workspace:save', ws),
  claudeAvailable: () => ipcRenderer.invoke('claude:available'),
  claudeSessionExists: (sessionId) => ipcRenderer.invoke('claude:sessionExists', sessionId),
  claudeSessionMeta: (sessionId) => ipcRenderer.invoke('claude:sessionMeta', sessionId),
  claudeSessionUsage: (sessionId) => ipcRenderer.invoke('claude:sessionUsage', sessionId),
  claudeDetect: () => ipcRenderer.invoke('claude:detect'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  npmPing: (url) => ipcRenderer.invoke('npm:ping', url),
  ccListInstalled: () => ipcRenderer.invoke('cc:listInstalled'),
  ccListRemote: () => ipcRenderer.invoke('cc:listRemote'),
  ccInstall: (version) => ipcRenderer.invoke('cc:install', version),
  ccInstallCancel: (version) => ipcRenderer.invoke('cc:installCancel', version),
  ccUninstall: (version) => ipcRenderer.invoke('cc:uninstall', version),
  ccCurrentVersion: () => ipcRenderer.invoke('cc:currentVersion'),
  onCcInstallPhase: (cb) => {
    const h = (_e: IpcRendererEvent, p: { version: string; phase: string }): void => cb(p)
    ipcRenderer.on('cc:install:phase', h)
    return () => ipcRenderer.off('cc:install:phase', h)
  },
  claudeUsage: (force) => ipcRenderer.invoke('claude:usage', force),
  claudeAccountsLoad: () => ipcRenderer.invoke('claude-accounts:load'),
  claudeAccountGet: (id) => ipcRenderer.invoke('claude-accounts:get', id),
  claudeAccountSave: (input) => ipcRenderer.invoke('claude-accounts:save', input),
  claudeAccountActivate: (id) => ipcRenderer.invoke('claude-accounts:activate', id),
  claudeAccountDelete: (id) => ipcRenderer.invoke('claude-accounts:delete', id),
  onClaudeAccountsChanged: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('claude-accounts:changed', h)
    return () => ipcRenderer.off('claude-accounts:changed', h)
  },
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
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  deferUpdate: () => ipcRenderer.invoke('update:defer'),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (cb) => {
    const h = (_e: IpcRendererEvent, ev: UpdateEvent): void => cb(ev)
    ipcRenderer.on('update:event', h)
    return () => ipcRenderer.off('update:event', h)
  },
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
  tabHistoryUpsertMany: (entries) => ipcRenderer.invoke('tabHistory:upsertMany', entries),
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
  floaterSetFocusable: (on) => ipcRenderer.send('floater:setFocusable', !!on),
  floaterMoveTo: (x, y) => ipcRenderer.send('floater:moveTo', { x, y }),
  floaterDragState: (on) => ipcRenderer.send('floater:dragState', !!on),
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
  consumePendingOpenHere: () => ipcRenderer.invoke('app:consumePendingOpenHere'),
  relaunchApp: () => ipcRenderer.send('app:relaunch'),

  // 多窗口 / 标签跨窗口迁移
  windowId: () => ipcRenderer.invoke('window:id'),
  tabClaim: (tabId) => ipcRenderer.send('tab:claim', tabId),
  tabRelease: (tabId) => ipcRenderer.send('tab:release', tabId),
  tabMoveToWindow: (opts) => ipcRenderer.invoke('tab:moveToWindow', opts),
  ptyHold: (ptyId) => ipcRenderer.invoke('pty:hold', ptyId),
  onTabExportRequest: (cb) => {
    const h = (_e: IpcRendererEvent, req: { reqId: string; tabId: string }) => cb(req)
    ipcRenderer.on('tab:export-request', h)
    return () => ipcRenderer.off('tab:export-request', h)
  },
  tabExportReply: (reqId, payload) => ipcRenderer.send(`tab:export-reply:${reqId}`, payload),
  onTabImport: (cb) => {
    const h = (_e: IpcRendererEvent, payload: TabTransferPayload) => cb(payload)
    ipcRenderer.on('tab:import', h)
    return () => ipcRenderer.off('tab:import', h)
  },
  tabImportDone: (tabId, ptyId) => ipcRenderer.send('tab:import-done', { tabId, ptyId }),
  secondaryReady: () => ipcRenderer.send('window:secondary-ready'),
  onSettingsChanged: (cb) => {
    const h = (_e: IpcRendererEvent, s: Settings) => cb(s)
    ipcRenderer.on('settings:changed', h)
    return () => ipcRenderer.off('settings:changed', h)
  },
  onWorkspaceChanged: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('workspace:changed', h)
    return () => ipcRenderer.off('workspace:changed', h)
  }
}

contextBridge.exposeInMainWorld('term', api)
