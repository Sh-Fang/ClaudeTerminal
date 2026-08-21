// controller.ts —— 业务核心。状态是"就地可变 + 显式刷新"：改动后调 refreshUI()（store bump + 悬浮窗计数推送），
// 订阅 rev 的组件重拉 getter 数据；弹窗/菜单/toast 走 state/overlays 命令式 API。
import { TerminalTab, type SessionRecord } from './terminal-tab'
import { DEFAULT_SETTINGS, type Settings } from './themes'
import {
  defaultSessionTitle,
  escapeHtml,
  formatTs,
  naturalNameCompare,
  recencyDesc,
  sessionTitle,
  shortPath
} from './lib/format'
import {
  closePickTabs,
  confirmDialog,
  isConfirmOpen,
  openMemoEditor,
  openModal,
  openPickTabs,
  openSearchOverlay,
  closeSearchOverlay,
  showCtxMenu,
  toast,
  type CtxItem,
  type PickItem
} from './state/overlays'
import { icon } from './svg-icons'
import { setLanguage, t } from './i18n'
import { bump } from './state/store'
import { busEmit } from './state/bus'
import type {
  GroupView,
  SavedView,
  SavedWorkspaceView,
  ManageGroupView,
  ManageWorkspaceView,
  HistoryEntry
} from './app-types'

export type {
  GroupView,
  SavedView,
  SavedWorkspaceView,
  ManageGroupView,
  ManageWorkspaceView,
  ManageTabView,
  ManageSessionView,
  ManageWorkspaceGroupView,
  HistoryEntry
} from './app-types'

// hosts 元素：xterm 命令式挂载的宿主容器。initApp 开头 await hostsReady，保证恢复标签时 hostsEl 可用。
let hostsEl: HTMLDivElement | null = null
let hostsReadyResolve: (() => void) | null = null
const hostsReady = new Promise<void>((resolve) => {
  hostsReadyResolve = resolve
})

export function setHostsEl(el: HTMLDivElement | null): void {
  // 卸载（null）不清引用：已 mount 的 xterm DOM 还挂在旧元素上，清了反而拿不回
  if (!el) return
  hostsEl = el
  hostsReadyResolve?.()
  hostsReadyResolve = null
}

export interface Group {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

// 标签是否"承载 cc"：勾了自动启动，或实际起过会话——cct 手动起的 autoLaunchCC=false 但有真实会话，也算。
export function isCcTab(t: TerminalTab): boolean {
  return t.autoLaunchCC || t.sessions.length > 0
}

function isPureNonCcGroup(g: Group): boolean {
  return g.tabs.length > 0 && g.tabs.every((t) => !isCcTab(t))
}

function isTabExpendable(t: TerminalTab): boolean {
  return !isCcTab(t)
}

// 分组是否"脏"：有承载 cc 的脏标签、元信息与已保存不一致、或无保存条目。纯 pwsh 分组永远不脏。
function isGroupDirty(g: Group): boolean {
  if (isPureNonCcGroup(g)) return false
  // 用 isCcTab 而非 autoLaunchCC：cct 手动起的会话也要能让分组显 dirty
  if (g.tabs.some((t) => t.dirty && isCcTab(t))) return true
  const saved = savedGroups.find((s) => s.srcId === g.id)
  if (!saved) return true
  if (saved.snapshot.name !== g.name) return true
  if (saved.snapshot.cwd !== g.cwd) return true
  return false
}

interface SavedTab {
  id: string
  name: string
  sessions: SessionRecord[]
  activeSessionId?: string
  autoLaunchCC: boolean
  memo?: string
  savedAt: string
}
interface SavedGroup {
  id: string
  name: string
  cwd: string
  savedAt: string
  lastRestoredAt?: string
  snapshot: {
    name: string
    cwd: string
    tabs: SavedTab[]
  }
  srcId?: string
}

interface SavedWorkspaceSnapshotTab extends SavedTab {}
interface SavedWorkspaceSnapshotGroup {
  id: string
  name: string
  cwd: string
  tabs: SavedWorkspaceSnapshotTab[]
}
interface SavedWorkspace {
  id: string
  name: string
  savedAt: string
  lastRestoredAt?: string
  snapshot: {
    groups: SavedWorkspaceSnapshotGroup[]
    activeTabId: string | null
  }
}

const groups: Group[] = []
const savedGroups: SavedGroup[] = []
const savedWorkspaces: SavedWorkspace[] = []
let activeTabId: string | null = null
let saveDebounceTimer: number | null = null
let settings: Settings = DEFAULT_SETTINGS
let settingsSaveTimer: number | null = null
export function getSettings(): Settings {
  return settings
}

function pushFloaterCounts(): void {
  if (!settings.showFloater) return
  let done = 0, attention = 0, busy = 0, total = 0
  for (const g of groups) {
    for (const t of g.tabs) {
      total++
      const st = t.status ?? 'idle'
      if (st === 'done') done++
      else if (st === 'attention') attention++
      else if (st === 'busy') busy++
    }
  }
  window.term.floaterPush({ done, attention, busy, total })
}

// 统一刷新入口：bump 触发订阅 rev 的组件重渲染，悬浮窗计数一并跟着刷。
function refreshUI(): void {
  bump()
  pushFloaterCounts()
}

function applySettingsToAll(): void {
  for (const g of groups) for (const t of g.tabs) t.applySettings(settings)
}

export function updateSettings(s: Settings): void {
  const prevFloater = settings.showFloater
  const prevTabBar = settings.tabBarMode
  settings = s
  applySettingsToAll()
  refreshUI()
  // 垂直/水平布局切换改变终端可用宽度 —— 布局稳定后重排一次
  if (prevTabBar !== settings.tabBarMode) {
    setTimeout(() => activeContext()?.tab.refit(), 60)
  }
  if (prevFloater !== settings.showFloater) {
    window.term.floaterSetEnabled(settings.showFloater)
  }
  if (settings.showFloater) pushFloaterCounts()
  persistSettings()
}

// 就地合并（不落盘不刷新）：拖拽过程高频调用，拖完由调用方自己 persistSettings。
export function patchSettingsLive(p: Partial<Settings>): void {
  settings = { ...settings, ...p }
}

export function persistSettings(): void {
  if (settingsSaveTimer != null) window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null
    // 合并而非整体替换：旧构建主进程的归一化会把新字段悄悄抹掉
    void window.term.saveSettings(settings).then((normed) => { settings = { ...settings, ...normed } })
  }, 300)
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

const IS_WIN_PLATFORM = window.term.platform === 'win32'

function quoteShell(s: string): string {
  return IS_WIN_PLATFORM
    ? `'${s.replace(/'/g, "''")}'`
    : `'${s.replace(/'/g, "'\\''")}'`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 判断命令行是否「启动 cc」（claude / cct / claudePath basename）：命中则跳过 shell-busy，交给 cc hooks 驱动状态。
function commandLineIsCcInvocation(cmd: string | undefined, claudePath: string): boolean {
  if (!cmd) return false
  const m = /^\s*(?:&\s+)?(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(cmd)
  if (!m) return false
  const exe = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase()
  if (!exe) return false
  const base = exe.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|ps1|bat)$/i, '')
  if (base === 'claude') return true
  if (base === 'cct') return true
  if (claudePath) {
    const cpBase = claudePath.toLowerCase().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|ps1|bat)$/i, '') || ''
    if (cpBase && base === cpBase) return true
  }
  return false
}

let cachedHookSettingsArg: string | null = null
async function hookSettingsArg(): Promise<string> {
  if (cachedHookSettingsArg) return cachedHookSettingsArg
  const hp = await window.term.hookPaths()
  cachedHookSettingsArg = ` --settings ${quoteShell(hp.ccHooksJson)}`
  return cachedHookSettingsArg
}

function findTab(tabId: string): { group: Group; tab: TerminalTab } | null {
  for (const g of groups) {
    const t = g.tabs.find((x) => x.id === tabId)
    if (t) return { group: g, tab: t }
  }
  return null
}
export function activeContext(): { group: Group; tab: TerminalTab } | null {
  return activeTabId ? findTab(activeTabId) : null
}
function findGroup(groupId: string): Group | undefined {
  return groups.find((g) => g.id === groupId)
}

export function getActiveTabId(): string | null {
  return activeTabId
}

export function refitActive(): void {
  activeContext()?.tab.refit()
}

export function getToolbarCtx(): { tab: TerminalTab; groupName: string; groupCwd: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
}

export function getSessionInfoCtx(): { sessionId: string | null; cwd: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { sessionId: ctx.tab.activeSessionId ?? null, cwd: ctx.group.cwd }
}

// 轻量持久化：只写已保存条目，当前打开的分组不落盘，随窗口关闭即销毁。
function scheduleSave(): void {
  if (saveDebounceTimer != null) window.clearTimeout(saveDebounceTimer)
  saveDebounceTimer = window.setTimeout(() => {
    saveDebounceTimer = null
    void window.term.saveWorkspace({
      version: 2,
      groups: [],
      savedGroups: savedGroups.map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        savedAt: s.savedAt,
        lastRestoredAt: s.lastRestoredAt,
        tabCount: s.snapshot.tabs.length,
        srcId: s.srcId,
        snapshot: {
          id: s.srcId || s.id,
          name: s.snapshot.name,
          cwd: s.snapshot.cwd,
          collapsed: false,
          tabs: s.snapshot.tabs.map((t) => ({
            id: t.id,
            name: t.name,
            sessions: t.sessions,
            activeSessionId: t.activeSessionId,
            autoLaunchCC: t.autoLaunchCC,
            memo: t.memo
          }))
        }
      })),
      savedWorkspaces: savedWorkspaces.map((w) => ({
        id: w.id,
        name: w.name,
        savedAt: w.savedAt,
        lastRestoredAt: w.lastRestoredAt,
        groupCount: w.snapshot.groups.length,
        tabCount: w.snapshot.groups.reduce((n, g) => n + g.tabs.length, 0),
        snapshot: {
          groups: w.snapshot.groups.map((g) => ({
            id: g.id,
            name: g.name,
            cwd: g.cwd,
            collapsed: false,
            tabs: g.tabs.map((t) => ({
              id: t.id,
              name: t.name,
              sessions: t.sessions,
              activeSessionId: t.activeSessionId,
              autoLaunchCC: t.autoLaunchCC,
              memo: t.memo
            }))
          })),
          activeTabId: w.snapshot.activeTabId
        }
      })),
      activeTabId
    })
  }, 300)
}

// 标签历史：打开/激活/会话栈变化时写入（崩溃后找回）；同 tab 1.5s 节流，关键时机 force=true 立刻落。
const historyFlushAt = new Map<string, number>()
// 恢复合批：restore 期间每个 makeTab 都强刷一次历史（N 次主进程同步写盘），改为攒进
// Map（同 tab 留最新）在恢复收尾一次批量 upsert。null = 不在恢复中，走常规单条写。
let historyBatch: Map<string, HistoryEntry> | null = null
function beginHistoryBatch(): void {
  if (!historyBatch) historyBatch = new Map()
}
function flushHistoryBatch(): void {
  const batch = historyBatch
  historyBatch = null
  if (!batch || batch.size === 0) return
  void window.term.tabHistoryUpsertMany([...batch.values()])
}

function recordTabHistory(tab: TerminalTab, groupName: string, force = false): void {
  const now = Date.now()
  const last = historyFlushAt.get(tab.id) ?? 0
  if (!force && now - last < 1500) return
  historyFlushAt.set(tab.id, now)
  const entry: HistoryEntry = {
    tabId: tab.id,
    tabName: tab.name,
    groupName,
    cwd: tab.cwd,
    autoLaunchCC: tab.autoLaunchCC,
    sessions: tab.sessions.map((s) => ({ ...s })),
    activeSessionId: tab.activeSessionId,
    memo: tab.memo,
    openedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  }
  if (historyBatch) {
    historyBatch.set(tab.id, entry)
    return
  }
  void window.term.tabHistoryUpsert(entry)
}

// ── cc 启动并发闸门 ──────────────────────────────────────────────
// 恢复工作区/分组会在一瞬间为每个标签触发 launchCC，十几个 claude(node) 同时冷启动
// 会打满磁盘 IO + Defender 扫描，整机卡顿（CPU/内存都不高）。闸门限制同时启动数
//（每轮突发随机 2 或 3），其余排队；占位在该 tab 的 SessionStart hook 到达（cc 已
// 起来）或 500~1000ms 随机兜底超时后释放，先到先释放。
let ccGateActive = 0
let ccGateLimit = 3
const ccGateQueue: (() => void)[] = []
const ccGateHeld = new Set<string>()

function ccGateAcquire(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      ccGateActive++
      ccGateHeld.add(tabId)
      // 兜底释放：hook 丢失/cc 启动失败也不许永久占坑
      window.setTimeout(() => ccGateRelease(tabId), 500 + Math.floor(Math.random() * 500))
      resolve()
    }
    if (ccGateActive === 0 && ccGateQueue.length === 0) {
      ccGateLimit = 2 + (Math.random() < 0.5 ? 0 : 1)
    }
    if (ccGateActive < ccGateLimit) grant()
    else ccGateQueue.push(grant)
  })
}

function ccGateRelease(tabId: string): void {
  if (!ccGateHeld.delete(tabId)) return // 未占坑或已释放（超时与 hook 双触发）
  ccGateActive = Math.max(0, ccGateActive - 1)
  const next = ccGateQueue.shift()
  if (next) next()
}

async function launchCC(tab: TerminalTab): Promise<void> {
  if (!tab.autoLaunchCC) return
  if (tab.ptyId == null) return
  await ccGateAcquire(tab.id)
  // 排队期间 tab 可能已关闭 / pty 已退出
  if (tab.ptyId == null) {
    ccGateRelease(tab.id)
    return
  }

  const claudeBin = settings.claudePath.trim()
  if (claudeBin) {
    if (!(await window.term.pathExists(claudeBin))) {
      tab.term.writeln(`\x1b[33m${t('[claude 路径不存在：{0}，跳过自动启动]', claudeBin)}\x1b[0m`)
      tab.term.writeln(`\x1b[90m${t('请到设置 → Claude Code 中重新选择 claude 可执行文件。')}\x1b[0m`)
      ccGateRelease(tab.id)
      return
    }
  } else {
    const available = await window.term.claudeAvailable()
    if (!available) {
      tab.term.writeln(`\x1b[90m${t('[claude 未在 PATH 中，跳过自动启动 Claude Code]')}\x1b[0m`)
      ccGateRelease(tab.id)
      return
    }
  }
  const claudeCmd = claudeBin ? quoteShell(claudeBin) : 'claude'
  // pwsh 里引号包住的绝对路径要加 & 调用操作符才执行；POSIX 不用
  const invoker = claudeBin && IS_WIN_PLATFORM ? '& ' : ''

  const settingsArg = await hookSettingsArg()
  const active = tab.activeSessionId
  let cmd: string
  if (active && UUID_RE.test(active) && (await window.term.claudeSessionExists(active))) {
    cmd = `${invoker}${claudeCmd} --resume ${active}${settingsArg}`
  } else {
    // 幽灵会话清理：旧 UUID 对应的 jsonl 已不在，从栈里移除
    if (active && UUID_RE.test(active)) {
      tab.sessions = tab.sessions.filter((s) => s.sessionId !== active)
    }
    const newId = crypto.randomUUID()
    tab.activeSessionId = newId
    scheduleSave()
    // 新会话带 --model；--resume 分支刻意不带，避免覆盖旧会话原有模型。白名单校验防注入。
    const model = settings.defaults.model
    const modelArg = /^[A-Za-z0-9._-]+$/.test(model) ? ` --model ${model}` : ''
    cmd = `${invoker}${claudeCmd} --session-id ${newId} --name ${quoteShell(tab.name)}${modelArg}${settingsArg}`
  }
  window.term.send(tab.ptyId, cmd + '\r')
}

// 顶栏"启动 CC"按钮：在纯 pwsh 标签里手动起可被接管的 cc（等效手敲 cct），hook 上报后压栈接管。
export function startCcInActiveTab(): void {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (isCcTab(tab)) return       // 已勾自动启动或已起过会话 → 不重复起
  if (tab.ptyId == null) return  // pty 还没就绪
  window.term.send(tab.ptyId, 'cct\r')
  tab.term.focus()
}

function makeTab(group: Group, opts: {
  id?: string
  name: string
  sessions?: SessionRecord[]
  activeSessionId?: string
  autoLaunchCC?: boolean
  status?: TerminalTab['status']
  note?: string
  memo?: string
  dirty?: boolean
  // 跨窗口迁移：迁移前 cc 是否活跃（普通新建/恢复不传，默认 false）
  ccActive?: boolean
}): TerminalTab {
  const id = opts.id || uid('t_')
  let tabRef!: TerminalTab
  tabRef = new TerminalTab(
    {
      id,
      name: opts.name,
      cwd: group.cwd,
      sessions: opts.sessions,
      activeSessionId: opts.activeSessionId,
      autoLaunchCC: opts.autoLaunchCC,
      status: opts.status,
      note: opts.note,
      memo: opts.memo,
      dirty: opts.dirty,
      settings
    },
    {
      copySelectionAsAnswer: () => false,
      openSearch: openSearchOverlay,
      onRequestNewTab: () => promptNewTabInGroup(group.id),
      onRequestCloseSelf: () => closeTab(id),
      onRequestSaveGroup: saveActiveDirtyGroup,
      onPtyStarted: () => void launchCC(tabRef),
      onUserAbort: () => {
        if (tabRef.status !== 'busy') return
        tabRef.status = 'idle'
        tabRef.note = undefined
        refreshUI()
      },
      // cc API Error：terminal-tab 已置 status=error，这里补 note 并刷新（红点需手动清除）
      onErrorDetected: (note) => {
        tabRef.note = note
        refreshUI()
      },
      onShellCommand: (kind, cmd) => {
        // shell integration OSC 触发 → pwsh 一定在前台（cc 全屏 TUI 会屏蔽这些序列），据此翻回 ccActive
        if (tabRef.ccActive) {
          tabRef.ccActive = false
          // cc 刚退回 pwsh：无条件复位鼠标/焦点追踪，防 cc 异常退出漏关模式后鼠标移动狂刷乱码
          tabRef.resetInputTrackingModes()
          refreshUI()
        }
        // cc tab 状态完全交给 cc hooks，shell 事件不参与
        if (tabRef.autoLaunchCC) return
        if (kind === 'start' && commandLineIsCcInvocation(cmd, settings.claudePath)) return
        if (kind === 'start') {
          if (tabRef.status === 'busy') return
          tabRef.status = 'busy'
          tabRef.note = undefined
        } else {
          // 只把「自己刚起的 busy」降回 idle，不覆盖 error 之类
          if (tabRef.status !== 'busy') return
          tabRef.status = 'idle'
          tabRef.note = undefined
        }
        refreshUI()
      }
    }
  )
  if (opts.ccActive) tabRef.ccActive = true
  group.tabs.push(tabRef)
  tabRef.mount(hostsEl!)
  // 多窗口路由：认领 tabId，主进程把该 tab 的 hook 事件推到本窗口
  window.term.tabClaim(id)
  recordTabHistory(tabRef, group.name, true)
  return tabRef
}

async function spawnTabPty(tab: TerminalTab): Promise<void> {
  // 等 setActive 的 rAF 跑完（fit 已算出真实 cols/rows）再 startPty；
  // 否则 PTY 以 display:none 时的 80×24 启动，cc splash 画到一半收 SIGWINCH 会整屏错位。
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: awaiting rAF before startPty')
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: rAF done, calling startPty')
  await tab.startPty()
  void refreshSessionMeta(tab)
}

// 每帧只起一小批 PTY，批间让出一帧，避免恢复多标签时长任务卡死 UI 线程。
const RESTORE_BATCH = 2
async function spawnTabsBatched(tabs: TerminalTab[]): Promise<void> {
  for (let i = 0; i < tabs.length; i += RESTORE_BATCH) {
    if (i > 0) await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await Promise.all(tabs.slice(i, i + RESTORE_BATCH).map((t) => spawnTabPty(t)))
  }
}

async function refreshSessionMeta(tab: TerminalTab): Promise<void> {
  let changed = false
  for (const s of tab.sessions) {
    const meta = await window.term.claudeSessionMeta(s.sessionId)
    if (!meta.exists) continue
    if (meta.lastTs && meta.lastTs !== s.lastTs) {
      s.lastTs = meta.lastTs
      changed = true
    }
  }
  if (changed) {
    scheduleSave()
    refreshUI()
  }
}

function ensureGroup(opts: { name: string; cwd: string }): Group {
  const g: Group = {
    id: uid('g_'),
    name: opts.name,
    cwd: opts.cwd,
    collapsed: false,
    tabs: []
  }
  groups.push(g)
  return g
}

export async function newGroup(): Promise<void> {
  const prefilledCwd = settings.lastUsedCwd || settings.defaults.cwd
  openModal({
    kind: 'new-group',
    title: t('新建分组'),
    sub: t('分组以路径为单位。组内可挂多个标签。'),
    name: t('新分组'),
    cwd: prefilledCwd,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    showTabName: true,
    tabName: 'A',
    okLabel: t('创建'),
    autoNameFromCwd: true,
    onPickCwd: (cur) => window.term.pickDirectory(cur || prefilledCwd),
    onOk: async (v) => {
      const cwd = v.cwd?.trim() || ''
      const g = ensureGroup({ name: v.name, cwd })
      refreshUI()
      const firstTabName = v.tabName?.trim() || 'A'
      const tab = makeTab(g, { name: firstTabName, autoLaunchCC: v.autoLaunchCC })
      activeTabId = tab.id
      activateUI(tab.id)
      await spawnTabPty(tab)
      if (cwd && cwd !== settings.lastUsedCwd) {
        settings = { ...settings, lastUsedCwd: cwd }
        void window.term.saveSettings(settings)
      }
      scheduleSave()
      toast(t('已新建分组「{0}」', g.name))
    }
  })
}

// 右键"在此处打开"：同 cwd 的 live 分组直接加 tab，否则新建并重绑已保存分组的 srcId（触发 dirty 提示保存）。
function basenameOfPath(p: string): string {
  // 磁盘根（D:\ 等）没有"最后一段"，美化成「D 盘」
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return t('{0} 盘', drive[1].toUpperCase())
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? p
}

async function openHereWithPath(rawPath: string): Promise<void> {
  const p = (rawPath || '').trim()
  if (!p) return
  const exists = await window.term.pathExists(p)
  if (!exists) {
    toast(t('路径不存在：{0}', p))
    return
  }
  const bn = basenameOfPath(p) || p
  const cc = settings.defaults.autoLaunchCC
  let g = groups.find((x) => x.cwd === p)
  if (!g) {
    g = ensureGroup({ name: bn, cwd: p })
    const saved = savedGroups.find((s) => s.name === g!.name && s.cwd === g!.cwd)
    if (saved) saved.srcId = g.id
  }
  const tabName = String.fromCharCode(65 + g.tabs.length)
  const tab = makeTab(g, { name: tabName, autoLaunchCC: cc })
  g.collapsed = false
  activeTabId = tab.id
  refreshUI()
  activateUI(tab.id)
  await spawnTabPty(tab)
  scheduleSave()
  if (p !== settings.lastUsedCwd) {
    settings = { ...settings, lastUsedCwd: p }
    void window.term.saveSettings(settings)
  }
  toast(t('已在「{0}」新建标签', g.name))
}

export async function promptNewTabInGroup(groupId: string): Promise<void> {
  const g = findGroup(groupId)
  if (!g) return
  const nm = String.fromCharCode(65 + g.tabs.length)
  openModal({
    kind: 'new-tab',
    title: t('在「{0}」新建标签', g.name),
    sub: t('同分组共用 cwd。'),
    name: nm,
    cwd: undefined,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    okLabel: t('创建'),
    onOk: async (v) => {
      const tab = makeTab(g, { name: v.name, autoLaunchCC: v.autoLaunchCC })
      g.collapsed = false
      activeTabId = tab.id
      refreshUI()
      activateUI(tab.id)
      await spawnTabPty(tab)
      scheduleSave()
    }
  })
}

function activateUI(tabId: string): void {
  for (const g of groups) for (const t of g.tabs) t.setActive(t.id === tabId)
  refreshUI()
}

// 管理弹窗里对"已保存分组"新增标签：确认后打开该分组 + 新标签，并立即写回保存快照（不留脏）。
export function addTabToSavedGroup(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  openModal({
    kind: 'new-tab',
    title: t('在「{0}」新增标签页', s.name),
    sub: t('确认后会在后台打开该分组和新标签页，并自动保存到该分组。'),
    name: String.fromCharCode(65 + Math.min(25, s.snapshot.tabs.length)),
    cwd: undefined,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    okLabel: t('创建'),
    onOk: async (v) => {
      // 复用已打开实例（srcId → name+cwd 兜底），并重绑 srcId 供 isGroupDirty/autoSync 命中
      let g = groups.find((x) => x.id === s.srcId)
        || groups.find((x) => x.name === s.name && x.cwd === s.cwd)
      if (!g) g = ensureGroup({ name: s.name, cwd: s.cwd })
      s.srcId = g.id
      const tab = makeTab(g, { name: v.name, autoLaunchCC: v.autoLaunchCC, dirty: false })
      g.collapsed = false
      activeTabId = tab.id
      activateUI(tab.id)
      await spawnTabPty(tab)
      const savedAt = new Date().toISOString()
      s.snapshot.tabs.push(snapshotTabFromLive(tab, savedAt))
      s.savedAt = savedAt
      tab.dirty = false
      refreshUI()
      scheduleSave()
      toast(t('已在「{0}」新增并保存标签「{1}」', s.name, tab.name))
    }
  })
}

// 查看降级：切到 done 标签且主窗口有焦点，停留 N 秒后降回 idle；失焦暂停、回焦重新计满 N 秒。
// attention 不参与降级：只能由 cc 发新状态或手动"标记为已查看"清除。
let downgradeTimer: number | null = null
let downgradeTabId: string | null = null
let downgradeFromStatus: TerminalTab['status'] | null = null
function clearDowngradeTimer(): void {
  if (downgradeTimer != null) { window.clearTimeout(downgradeTimer); downgradeTimer = null }
  downgradeTabId = null
  downgradeFromStatus = null
}
function maybeStartDowngrade(tabId: string, st: TerminalTab['status']): void {
  if (activeTabId !== tabId) return
  if (st !== 'done') return
  // 主窗口失焦时不启动倒计时；focus 事件回来时 resumeDowngradeIfNeeded 会再调一次
  if (!document.hasFocus()) return
  clearDowngradeTimer()
  downgradeTabId = tabId
  downgradeFromStatus = st
  downgradeTimer = window.setTimeout(() => {
    downgradeTimer = null
    const c = findTab(tabId)
    const from = downgradeFromStatus
    downgradeTabId = null
    downgradeFromStatus = null
    if (!c) return
    if (activeTabId !== tabId) return
    if (c.tab.status !== from) return
    c.tab.status = 'idle'
    c.tab.note = undefined
    refreshUI()
    scheduleSave()
  }, settings.statusDowngradeSec * 1000)
}

function resumeDowngradeIfNeeded(): void {
  if (!activeTabId) return
  const ctx = findTab(activeTabId)
  if (!ctx) return
  maybeStartDowngrade(activeTabId, ctx.tab.status)
}

export function activateTab(tabId: string): void {
  if (activeTabId === tabId) return
  const ctx = findTab(tabId)
  if (!ctx) return
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, `activateTab ${activeTabId} -> ${tabId}`)
  activeTabId = tabId
  clearDowngradeTimer()
  maybeStartDowngrade(tabId, ctx.tab.status)
  activateUI(tabId)
  busEmit('sessionInfo:nudge')
  scheduleSave()
  recordTabHistory(ctx.tab, ctx.group.name)
}

function disposeTabInternal(group: Group, tab: TerminalTab): void {
  const idxInGroup = group.tabs.indexOf(tab)
  if (idxInGroup < 0) return
  group.tabs.splice(idxInGroup, 1)
  tab.dispose()
  window.term.tabRelease(tab.id)
  if (activeTabId === tab.id) {
    const next = pickNextActive(group, idxInGroup)
    activeTabId = next?.id ?? null
    if (next) activateUI(next.id)
  }
}

// 副窗口手动关空 → 自动关窗；拖走迁空由主进程迁移流程负责。
// tabRelease 先于 winClose（IPC 保序），主进程查表已无标签直接放行。
function maybeCloseEmptySecondary(): void {
  if (isSecondary && groups.length === 0) window.term.winClose()
}

export function closeTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { group, tab } = ctx
  const isLast = group.tabs.length === 1
  const finalize = (): void => {
    disposeTabInternal(group, tab)
    if (group.tabs.length === 0) {
      const idx = groups.indexOf(group)
      if (idx >= 0) groups.splice(idx, 1)
    }
    maybeCloseEmptySecondary()
    refreshUI()
    scheduleSave()
  }
  // 纯 pwsh 标签且非分组最后一个 → 跳过确认；最后一个会连带关分组，仍确认
  if (isTabExpendable(tab) && !isLast) {
    finalize()
    return
  }
  confirmDialog({
    title: t('关闭标签「{0}」？', tab.name),
    message: t('该标签下有 <b>{0}</b> 条会话，关闭后该标签将从分组移除。', tab.sessions.length) +
      (isLast ? t('<br/>这是分组「{0}」的最后一个标签，关闭后<b>分组也会被关闭</b>。', escapeHtml(group.name)) : ''),
    okLabel: t('关闭标签'),
    onOk: finalize
  })
}

function pickNextActive(group: Group, idxInGroup: number): TerminalTab | null {
  const sibling = group.tabs[idxInGroup] || group.tabs[idxInGroup - 1]
  if (sibling) return sibling
  for (const g of groups) {
    if (g.tabs.length > 0) return g.tabs[0]
  }
  return null
}

export function renameTab(tabId: string, newName: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  if (!newName.trim()) return
  ctx.tab.name = newName.trim()
  ctx.tab.dirty = true
  refreshUI()
  scheduleSave()
}

export function toggleGroupCollapse(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  g.collapsed = !g.collapsed
  refreshUI()
  scheduleSave()
}

export function setAllGroupsCollapsed(collapsed: boolean): void {
  if (groups.length === 0) return
  let changed = false
  for (const g of groups) {
    if (g.collapsed !== collapsed) {
      g.collapsed = collapsed
      changed = true
    }
  }
  if (!changed) return
  refreshUI()
  scheduleSave()
}

export function locateActiveTab(): void {
  const ctx = activeContext()
  if (!ctx) {
    toast(t('当前没有活动标签'))
    return
  }
  if (ctx.group.collapsed) {
    ctx.group.collapsed = false
    refreshUI()
    scheduleSave()
  }
  // React 渲染异步：刚展开分组的行元素要等下次 commit 才存在，DOM 查询延迟到 rAF
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `#groupList .tab-row[data-t="${CSS.escape(ctx.tab.id)}"]`
    )
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 先移除再强制 reflow：连续点击时也能重新触发闪烁动画
    row.classList.remove('locate-flash')
    void row.offsetWidth
    row.classList.add('locate-flash')
    row.addEventListener('animationend', () => row.classList.remove('locate-flash'), { once: true })
  })
}

function renameGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  openModal({
    kind: 'rename',
    title: t('重命名分组'),
    sub: t('只改名字，cwd 与标签保持不变。'),
    name: g.name,
    okLabel: t('保存'),
    onOk: (v) => {
      g.name = v.name
      refreshUI()
      scheduleSave()
      toast(t('已重命名分组'))
    }
  })
}

function snapshotTabFromLive(t: TerminalTab, savedAt: string): SavedTab {
  return {
    id: t.id,
    name: t.name,
    sessions: t.sessions.map((s) => ({ ...s })),
    activeSessionId: t.activeSessionId,
    autoLaunchCC: t.autoLaunchCC,
    memo: t.memo,
    savedAt
  }
}

// 自动同步：tab 会话栈变化时若分组已保存，静默覆盖 saved 快照——外观没变就不打 dirty。
function autoSyncTabToSaved(tab: TerminalTab, group: Group): void {
  const saved = savedGroups.find((s) => s.srcId === group.id)
  if (!saved) return
  const savedAt = new Date().toISOString()
  saved.snapshot.tabs = mergeTabsIntoSnapshot(saved.snapshot.tabs, [tab], savedAt)
  saved.savedAt = savedAt
}

// 增量合并：以 tab.id 去重 upsert；不会从快照里删除已保存的标签
function mergeTabsIntoSnapshot(snapTabs: SavedTab[], liveTabs: TerminalTab[], savedAt: string): SavedTab[] {
  const out = [...snapTabs]
  for (const t of liveTabs) {
    const idx = out.findIndex((x) => x.id === t.id)
    const next = snapshotTabFromLive(t, savedAt)
    if (idx >= 0) out[idx] = next
    else out.push(next)
  }
  return out
}

// 按 tab.id 去重合并；撞 id 时保留 savedAt 更新的那条。
function mergeSavedTabLists(a: SavedTab[], b: SavedTab[]): SavedTab[] {
  const map = new Map<string, SavedTab>()
  for (const t of a) map.set(t.id, t)
  for (const t of b) {
    const ex = map.get(t.id)
    if (!ex || (t.savedAt || '') > (ex.savedAt || '')) map.set(t.id, t)
  }
  return [...map.values()]
}

// 同名同路径的 saved 条目合并为一条（saveGroup / 启动加载后调用）。
function dedupSavedByNameCwd(): void {
  const byKey = new Map<string, SavedGroup>()
  const out: SavedGroup[] = []
  for (const s of savedGroups) {
    const key = `${s.name}\x00${s.cwd}`
    const first = byKey.get(key)
    if (!first) {
      byKey.set(key, s)
      out.push(s)
      continue
    }
    first.snapshot.tabs = mergeSavedTabLists(first.snapshot.tabs, s.snapshot.tabs)
    if ((s.savedAt || '') > (first.savedAt || '')) {
      first.savedAt = s.savedAt
      first.snapshot.name = s.snapshot.name
      first.snapshot.cwd = s.snapshot.cwd
    }
    // srcId：优先保留指向当前活着的 live 分组，更便于后续 autoSync 命中
    const firstAlive = !!(first.srcId && findGroup(first.srcId))
    const sAlive = !!(s.srcId && findGroup(s.srcId))
    if (!firstAlive && sAlive) first.srcId = s.srcId
  }
  savedGroups.splice(0, savedGroups.length, ...out)
}

// 查找 merge 目标：先按 srcId，再按 name+cwd 兜底。
function findSavedForGroup(g: Group): SavedGroup | undefined {
  const bySrc = savedGroups.find((s) => s.srcId === g.id)
  if (bySrc) return bySrc
  return savedGroups.find((s) => s.name === g.name && s.cwd === g.cwd)
}

function saveGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const savedAt = new Date().toISOString()
  const existing = findSavedForGroup(g)
  if (existing) {
    existing.srcId = g.id
    existing.name = g.name
    existing.cwd = g.cwd
    existing.savedAt = savedAt
    existing.snapshot = {
      name: g.name,
      cwd: g.cwd,
      tabs: mergeTabsIntoSnapshot(existing.snapshot.tabs, g.tabs, savedAt)
    }
  } else {
    savedGroups.unshift({
      id: uid('sv_'),
      name: g.name,
      cwd: g.cwd,
      savedAt,
      snapshot: {
        name: g.name,
        cwd: g.cwd,
        tabs: g.tabs.map((t) => snapshotTabFromLive(t, savedAt))
      },
      srcId: g.id
    })
  }
  dedupSavedByNameCwd()
  for (const t of g.tabs) t.dirty = false
  refreshUI()
  scheduleSave()
  toast(t('已保存「{0}」（{1} 个标签）', g.name, g.tabs.length))
}

function saveTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { group: g, tab } = ctx
  const savedAt = new Date().toISOString()
  let saved = findSavedForGroup(g)
  if (!saved) {
    saved = {
      id: uid('sv_'),
      name: g.name,
      cwd: g.cwd,
      savedAt,
      snapshot: { name: g.name, cwd: g.cwd, tabs: [] },
      srcId: g.id
    }
    savedGroups.unshift(saved)
  } else {
    saved.srcId = g.id
  }
  saved.snapshot.tabs = mergeTabsIntoSnapshot(saved.snapshot.tabs, [tab], savedAt)
  saved.savedAt = savedAt
  saved.name = g.name
  saved.cwd = g.cwd
  saved.snapshot.name = g.name
  saved.snapshot.cwd = g.cwd
  dedupSavedByNameCwd()
  tab.dirty = false
  refreshUI()
  scheduleSave()
  toast(t('已保存标签「{0}」', tab.name))
}

function closeGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const pureNonCc = isPureNonCcGroup(g)
  const saved = savedGroups.some((s) => s.srcId === g.id) && !isGroupDirty(g)
  const busyCount = g.tabs.filter((t) => t.status === 'busy' || t.status === 'attention').length
  const busyHint = busyCount > 0
    ? t('<br/><b>注意</b>：其中 <b>{0}</b> 个标签正在运行或待决策，关闭会立即中断。', busyCount)
    : ''
  const doClose = (): void => {
    for (const t of g.tabs) {
      t.dispose()
      window.term.tabRelease(t.id)
    }
    const idx = groups.indexOf(g)
    groups.splice(idx, 1)
    if (activeTabId && !findTab(activeTabId)) {
      const next = groups.flatMap((x) => x.tabs)[0]
      activeTabId = next?.id ?? null
      if (next) activateUI(next.id)
    }
    maybeCloseEmptySecondary()
    refreshUI()
    scheduleSave()
    toast(t('已关闭分组「{0}」', g.name))
  }
  // 纯 pwsh 分组 + 无 busy → 直接关闭；其余一律二次确认
  if (pureNonCc && busyCount === 0) {
    doClose()
    return
  }
  confirmDialog({
    title: t('关闭分组「{0}」？', g.name),
    message: t('将关闭该分组下的 {0} 个标签。', g.tabs.length) +
      (saved
        ? t('该分组<b>已保存</b>，之后可在「已保存的分组」一键恢复。')
        : t('该分组<b>尚未保存</b>（或有改动未保存），关闭后将无法恢复其标签布局。')) +
      busyHint,
    okLabel: t('关闭分组'),
    onOk: doClose
  })
}

const PICK_ACTION_NEW_BLANK = '__new_blank__'

// 按 tabIds 把保存的标签实例化进 live 分组（已在 live 的跳过）；含 NEW_BLANK 则再建空白标签并同步进快照。
export async function restoreSavedTabs(
  savedId: string,
  tabIds: string[],
  blankName?: string,
  blankAutoLaunchCC?: boolean,
  // 会话级恢复：tabId → 指定的活跃会话；会话栈整份照带
  sessionOverride?: Map<string, string>
): Promise<void> {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  const addBlank = tabIds.includes(PICK_ACTION_NEW_BLANK)
  const realIds = tabIds.filter((id) => id !== PICK_ACTION_NEW_BLANK)
  const wanted = new Set(realIds)
  const picks = s.snapshot.tabs.filter((t) => wanted.has(t.id))

  let g = s.srcId ? findGroup(s.srcId) : undefined
  const created: TerminalTab[] = []
  if (!g) {
    g = ensureGroup({ name: s.name, cwd: s.cwd })
    s.srcId = g.id
  }
  const liveIds = new Set(g.tabs.map((t) => t.id))
  beginHistoryBatch()
  try {
    for (const t of picks) {
      if (liveIds.has(t.id)) continue
      const tab = makeTab(g, {
        id: t.id,
        name: t.name,
        sessions: t.sessions,
        activeSessionId: sessionOverride?.get(t.id) ?? t.activeSessionId,
        autoLaunchCC: t.autoLaunchCC,
        memo: t.memo,
        dirty: false
      })
      created.push(tab)
    }
    let blank: TerminalTab | null = null
    if (addBlank) {
      const nm = blankName?.trim() || String.fromCharCode(65 + g.tabs.length)
      const cc = blankAutoLaunchCC ?? settings.defaults.autoLaunchCC
      blank = makeTab(g, {
        name: nm,
        autoLaunchCC: cc,
        dirty: false
      })
      created.push(blank)
      autoSyncTabToSaved(blank, g)
    }
    // 真正带进标签才记恢复时间（卡片顶到侧边栏最前），no-op 不改时间
    if (created.length > 0) s.lastRestoredAt = new Date().toISOString()
    const firstCreated = created[0]
    if (firstCreated) {
      activeTabId = firstCreated.id
    } else if (!activeTabId) {
      const fb = g.tabs[0]
      if (fb) activeTabId = fb.id
    }
    refreshUI()
    if (activeTabId) activateUI(activeTabId)
    await spawnTabsBatched(created)
  } finally {
    flushHistoryBatch()
  }
  scheduleSave()
  const restoredN = created.length - (addBlank ? 1 : 0)
  if (created.length === 0) toast(t('分组「{0}」已经打开', s.name))
  else if (restoredN === 0 && addBlank) toast(t('在「{0}」新建了 1 个空白标签', s.name))
  else if (addBlank) toast(t('已恢复「{0}」{1} 个标签 + 1 个新空白', s.name, restoredN))
  else toast(t('已恢复「{0}」的 {1} 个标签', s.name, restoredN))
}

export function restoreSavedAll(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  void restoreSavedTabs(savedId, s.snapshot.tabs.map((t) => t.id))
}

export function openRestoreSelect(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  if (s.snapshot.tabs.length === 0) {
    toast(t('该保存的分组里没有标签'))
    return
  }
  const live = s.srcId ? findGroup(s.srcId) : undefined
  const liveIds = new Set(live?.tabs.map((t) => t.id) ?? [])
  // 会话级恢复：tabId → 指定的活跃会话，点「恢复」时连同勾选传给 restoreSavedTabs
  const overrides = new Map<string, string>()
  const items: PickItem[] = s.snapshot.tabs.map((st) => {
    const inLive = liveIds.has(st.id)
    const activeId = st.activeSessionId ?? st.sessions[st.sessions.length - 1]?.sessionId
    return {
      id: st.id,
      label: st.name,
      meta: inLive ? t('已在当前分组中') : t('{0} 个会话', st.sessions.length),
      disabled: inLive,
      defaultChecked: false,
      deleteTitle: t('从保存里删除此标签'),
      onDelete: () => deleteSavedTabFromPicker(savedId, st.id, st.name),
      sessionPick: inLive
        ? undefined
        : {
            // 只列重命名过的会话，默认名「会话 N」不参与选择；仍可用"用默认会话恢复"回退
            entries: st.sessions
              .filter((se) => se.userTitle)
              .map((se) => ({
                sessionId: se.sessionId,
                title: sessionTitle(se, st.sessions),
                source: se.source,
                ts: se.lastTs ?? se.createdAt,
                isDefault: se.sessionId === activeId
              })),
            onPick: (sid) => {
              if (sid) overrides.set(st.id, sid)
              else overrides.delete(st.id)
            }
          }
    }
  })
  items.push({
    id: PICK_ACTION_NEW_BLANK,
    label: '',
    defaultChecked: false,
    inputPlaceholder: t('+ 新建空白标签（直接输入名字）'),
    sideToggle: {
      defaultChecked: settings.defaults.autoLaunchCC,
      label: t('启动 CC'),
      title: t('新建标签是否自动启动 Claude Code；默认值来自「设置 → 新建默认值」')
    }
  })
  openPickTabs({
    title: t('恢复「{0}」的标签', s.name),
    sub: t('勾选要恢复的标签。已在当前分组中的标签会被跳过。'),
    items,
    okLabel: t('恢复'),
    onOk: (ids, inputs, toggles) =>
      void restoreSavedTabs(
        savedId,
        ids,
        inputs[PICK_ACTION_NEW_BLANK],
        toggles[PICK_ACTION_NEW_BLANK],
        overrides
      )
  })
}

// pick 弹窗里删单个标签：二次确认后从快照抽掉；删空也保留分组卡片。
function deleteSavedTabFromPicker(savedId: string, tabId: string, tabName: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  confirmDialog({
    title: t('从保存里移除「{0}」？', tabName),
    message: t('只把该标签从保存记录里删除，已打开的实例不受影响。'),
    okLabel: t('删除'),
    onOk: () => {
      const idx = s.snapshot.tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      s.snapshot.tabs.splice(idx, 1)
      refreshUI()
      scheduleSave()
      if (s.snapshot.tabs.length === 0) {
        closePickTabs()
        toast(t('「{0}」已没有保存的标签', s.name))
        return
      }
      // 弹窗里就地刷新一遍 —— 复用 openRestoreSelect，不闪不丢焦点。
      openRestoreSelect(savedId)
    }
  })
}

// 未接线的备用入口，保留导出
export function deleteSaved(savedId: string): void {
  const idx = savedGroups.findIndex((s) => s.id === savedId)
  if (idx < 0) return
  const s = savedGroups[idx]
  confirmDialog({
    title: t('删除已保存的「{0}」？', s.name),
    message: t('只删除保存记录，不影响当前打开的分组。'),
    okLabel: t('删除'),
    onOk: () => {
      savedGroups.splice(idx, 1)
      refreshUI()
      scheduleSave()
      toast(t('已删除保存的分组'))
    }
  })
}

// 未接线的备用入口，保留导出
export function renameSaved(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  openModal({
    kind: 'rename',
    title: t('重命名已保存的分组'),
    sub: t('只改保存项的名字。'),
    name: s.name,
    okLabel: t('保存'),
    onOk: (v) => {
      s.name = v.name
      s.snapshot.name = v.name
      dedupSavedByNameCwd()
      refreshUI()
      scheduleSave()
    }
  })
}

// 在新标签恢复该会话（--resume）；原标签栈记录保留，两处同开同一 sessionId 可能 jsonl 双写，已知边界不拦。
async function openSessionInNewTab(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { group, tab } = ctx
  const sess = tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const name = tabNameForSession(sess)
  const newTab = makeTab(group, {
    name,
    sessions: [{ ...sess }],
    activeSessionId: sess.sessionId,
    autoLaunchCC: true
  })
  group.collapsed = false
  activeTabId = newTab.id
  refreshUI()
  activateUI(newTab.id)
  await spawnTabPty(newTab)
  scheduleSave()
  toast(t('已在新标签打开会话「{0}」', name))
}

function tabNameForSession(s: SessionRecord): string {
  const raw = s.userTitle || t('会话 {0}', s.sessionId.slice(0, 8))
  return raw.length > 20 ? raw.slice(0, 19) + '…' : raw
}

// ─── 栈内会话右键菜单（重命名 / 删除；改完默认同步到 saved） ──────
export function openSessionCtx(sessionId: string, x: number, y: number): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const onlyOne = ctx.tab.sessions.length <= 1
  const items: CtxItem[] = [
    { label: t('在新标签页中打开该会话'), icon: icon('external-link'), act: () => void openSessionInNewTab(sessionId) },
    { sep: true },
    { label: t('重命名会话'), icon: icon('edit'), act: () => renameSession(sessionId) }
  ]
  if (sess.userTitle) {
    items.push({ label: t('清除自定义标题'), icon: icon('rotate-ccw'), act: () => renameSession(sessionId, '') })
  }
  items.push({ sep: true })
  if (onlyOne) {
    items.push({ label: t('删除（至少保留一条）'), icon: icon('trash'), act: () => toast(t('至少保留一条会话')) })
  } else {
    items.push({ label: t('删除会话'), icon: icon('trash'), danger: true, act: () => void deleteSession(sessionId) })
  }
  showCtxMenu(items, x, y)
}

function renameSession(sessionId: string, forceText?: string): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const apply = (v: string): void => {
    const trimmed = v.trim()
    if (trimmed) sess.userTitle = trimmed
    else delete sess.userTitle
    autoSyncTabToSaved(ctx.tab, ctx.group)
    refreshUI()
    scheduleSave()
  }
  // 显式清除分支：右键「清除自定义标题」时跳过 modal
  if (forceText === '') {
    apply('')
    toast(t('已清除自定义标题'))
    return
  }
  const current = sess.userTitle ?? ''
  openModal({
    kind: 'rename',
    title: t('重命名会话'),
    sub: t('不填就用默认名「会话 N」（N 按创建顺序）。右键菜单可「清除自定义标题」回到默认名。'),
    name: current,
    okLabel: t('保存'),
    onOk: (v) => apply(v.name)
  })
}

async function deleteSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { group, tab } = ctx
  if (tab.sessions.length <= 1) return
  const idx = tab.sessions.findIndex((s) => s.sessionId === sessionId)
  if (idx < 0) return
  const sess = tab.sessions[idx]
  const wasActive = tab.activeSessionId === sessionId
  const title = sess.userTitle || defaultSessionTitle(sess, tab.sessions)
  confirmDialog({
    title: t('删除会话「{0}」？', title),
    message: wasActive
      ? t('这是当前激活的会话，删除后会切到栈顶并重启 shell。<br/>已在磁盘的 cc 历史不会被删，只是从此标签的栈里移除。')
      : t('只把该会话从栈里移除。磁盘上的 cc 历史不受影响。'),
    okLabel: t('删除'),
    onOk: () => {
      tab.sessions.splice(idx, 1)
      if (wasActive) {
        const top = tab.sessions[tab.sessions.length - 1]
        tab.activeSessionId = top?.sessionId
        void tab.restartPty()
      }
      autoSyncTabToSaved(tab, group)
      refreshUI()
      scheduleSave()
      toast(t('已删除会话'))
    }
  })
}

export async function switchSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (!tab.sessions.some((s) => s.sessionId === sessionId)) return
  tab.activeSessionId = sessionId
  scheduleSave()
  await tab.restartPty()
  refreshUI()
  busEmit('sessionInfo:nudge')
}

export function openGroupCtx(groupId: string, x: number, y: number): void {
  const g = findGroup(groupId)
  if (!g) return
  showCtxMenu(
    [
      { label: t('新建会话标签'), icon: icon('plus'), act: () => promptNewTabInGroup(g.id) },
      { label: t('重命名分组'), icon: icon('edit'), act: () => renameGroup(g.id) },
      { sep: true },
      { label: t('保存分组'), icon: icon('save'), act: () => saveGroup(g.id) },
      { sep: true },
      { label: t('关闭分组'), icon: icon('close'), danger: true, act: () => closeGroup(g.id) }
    ],
    x,
    y
  )
}

// 手动标成 done（绿点）：不启动倒计时，下次切回该 tab 才开始降级计时。
export function markTabPending(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  ctx.tab.status = 'done'
  ctx.tab.note = undefined
  if (downgradeTabId === tabId) clearDowngradeTimer()
  refreshUI()
  scheduleSave()
}

// "标记为已查看"：手动清点（done/attention/error → idle）；busy 不清——cc 真在跑。
export function markTabViewed(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const s = ctx.tab.status
  if (s === 'idle' || s === 'busy') return
  ctx.tab.status = 'idle'
  ctx.tab.note = undefined
  if (downgradeTabId === tabId) clearDowngradeTimer()
  refreshUI()
  scheduleSave()
}

export function openTabCtx(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  // idle → 可标"待查看"；done/attention/error → 可标"已查看"；busy 都不给
  const s = ctx.tab.status ?? 'idle'
  const items: CtxItem[] = []
  if (s === 'idle') {
    items.push({ label: t('标记为待查看'), icon: icon('check-square'), act: () => markTabPending(tabId) })
  } else if (s === 'done' || s === 'attention' || s === 'error') {
    items.push({ label: t('标记为已查看'), icon: icon('square'), act: () => markTabViewed(tabId) })
  }
  showCtxMenu(
    [
      ...items,
      { label: t('保存标签'), icon: icon('save'), act: () => saveTab(tabId) },
      { sep: true },
      {
        label: t('重命名标签'),
        icon: icon('edit'),
        act: () => {
          openModal({
            kind: 'rename',
            title: t('重命名标签'),
            sub: '',
            name: ctx.tab.name,
            okLabel: t('保存'),
            onOk: (v) => renameTab(tabId, v.name)
          })
        }
      },
      // 添加/删除备注互斥：没备注给「添加」，有备注给「删除」（备注只能在这里删）
      ctx.tab.memo == null
        ? { label: t('添加备注'), icon: icon('sticky-note'), act: () => openTabMemoEditor(tabId, x, y) }
        : { label: t('删除备注'), icon: icon('sticky-note'), danger: true, act: () => deleteTabMemo(tabId) },
      { label: t('在本组新建标签'), icon: icon('plus'), act: () => promptNewTabInGroup(ctx.group.id) },
      // 刻意不传坐标：主进程会把「落点在现有窗口内」的带坐标请求当误触发拦掉
      { label: t('移到新窗口'), icon: icon('external-link'), act: () => void moveTabToNewWindow(tabId) },
      { sep: true },
      { label: t('关闭标签'), icon: icon('close'), danger: true, act: () => closeTab(tabId) }
    ],
    x,
    y
  )
}

// 备注编辑弹窗：关闭即保存（含首次添加的空文本——空备注也算"有备注"，图标照常显示，删除只走右键）
export function openTabMemoEditor(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  openMemoEditor({
    x,
    y,
    text: ctx.tab.memo ?? '',
    onSave: (text) => {
      const c = findTab(tabId)
      // 没改动不动状态；首次添加时 memo 还是 undefined，空文本也会落成空备注（右键项随之切到「删除备注」）
      if (!c || c.tab.memo === text) return
      c.tab.memo = text
      afterMemoChange(c)
    }
  })
}

function deleteTabMemo(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  ctx.tab.memo = undefined
  afterMemoChange(ctx)
}

// 备注跟标签走：变更写进所有已保存快照（分组 + 工作区）里同 id 的标签，
// 「先保存工作区/分组、后加备注」的快照恢复也能带回最新备注；删除同理清掉。
// 只就地改 memo 字段，不往快照里塞新标签（那是 autoSync 的语义）。
function syncMemoIntoSnapshots(tabId: string, memo: string | undefined): void {
  for (const s of savedGroups) {
    for (const t of s.snapshot.tabs) {
      if (t.id === tabId) t.memo = memo
    }
  }
  for (const w of savedWorkspaces) {
    for (const g of w.snapshot.groups) {
      for (const t of g.tabs) {
        if (t.id === tabId) t.memo = memo
      }
    }
  }
}

// 备注变更后的统一收尾：刷 UI + 静默同步进已保存快照（不打 dirty）+ 立刻刷标签历史（未保存的标签靠历史找回备注）
function afterMemoChange(ctx: { group: Group; tab: TerminalTab }): void {
  refreshUI()
  autoSyncTabToSaved(ctx.tab, ctx.group)
  syncMemoIntoSnapshots(ctx.tab.id, ctx.tab.memo)
  scheduleSave()
  recordTabHistory(ctx.tab, ctx.group.name, true)
}

function nextWorkspaceDefaultName(): string {
  let max = 0
  for (const w of savedWorkspaces) {
    // 中英两种默认名「工作区N」/「Workspace N」都参与取最大序号
    const m = /^(?:工作区|Workspace\s*)(\d+)$/.exec(w.name)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return t('工作区{0}', max + 1)
}

function promptSaveWorkspace(): void {
  if (groups.length === 0) {
    toast(t('当前工作区为空，没什么可保存的'))
    return
  }
  openModal({
    kind: 'rename',
    title: t('保存该工作区'),
    sub: t('把当前打开的分组、每个分组下的标签整体存档，之后可一键恢复。'),
    name: nextWorkspaceDefaultName(),
    okLabel: t('保存'),
    onOk: (v) => {
      const nm = v.name.trim() || nextWorkspaceDefaultName()
      saveCurrentAsWorkspace(nm)
    }
  })
}

function saveCurrentAsWorkspace(name: string): void {
  const savedAt = new Date().toISOString()
  const snapshotGroups: SavedWorkspaceSnapshotGroup[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    cwd: g.cwd,
    tabs: g.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      sessions: t.sessions,
      activeSessionId: t.activeSessionId,
      autoLaunchCC: t.autoLaunchCC,
      memo: t.memo,
      savedAt
    }))
  }))
  savedWorkspaces.unshift({
    id: uid('ws_'),
    name,
    savedAt,
    snapshot: { groups: snapshotGroups, activeTabId }
  })
  refreshUI()
  scheduleSave()
  toast(t('已保存工作区「{0}」（{1} 个分组）', name, snapshotGroups.length))
}

// 把快照分组追加恢复到当前工作区（整体/单分组共用）；已打开的只补齐缺失标签。返回新建数。
async function restoreSnapshotGroups(
  sgs: SavedWorkspaceSnapshotGroup[],
  preferActiveTabId: string | null
): Promise<number> {
  // 先建分组、收集标签规格；xterm/PTY 重活分批做
  const pending: { group: Group; spec: Parameters<typeof makeTab>[1] }[] = []
  for (const sg of sgs) {
    let g = findGroup(sg.id)
      || groups.find((x) => x.name === sg.name && x.cwd === sg.cwd)
    if (!g) g = ensureGroup({ name: sg.name, cwd: sg.cwd })
    // 有单分组保存记录则重绑 srcId，否则已保存分组恢复出来会因 srcId 对不上被误标脏
    const saved = findSavedForGroup(g)
    if (saved) saved.srcId = g.id
    const liveIds = new Set(g.tabs.map((t) => t.id))
    for (const t of sg.tabs) {
      if (liveIds.has(t.id)) continue
      pending.push({
        group: g,
        spec: {
          id: t.id,
          name: t.name,
          sessions: t.sessions,
          activeSessionId: t.activeSessionId,
          autoLaunchCC: t.autoLaunchCC,
          memo: t.memo,
          dirty: false
        }
      })
    }
  }
  refreshUI()
  if (pending.length === 0) return 0

  // 前台目标：快照的 active tab 或第一个；其所在批建好即激活，避免"先激活错的再跳"闪烁
  const targetActiveId =
    preferActiveTabId && pending.some((p) => p.spec.id === preferActiveTabId)
      ? preferActiveTabId
      : pending[0].spec.id

  let activated = false
  beginHistoryBatch()
  try {
    for (let i = 0; i < pending.length; i += RESTORE_BATCH) {
      if (i > 0) await new Promise<void>((r) => requestAnimationFrame(() => r()))
      const batchTabs = pending.slice(i, i + RESTORE_BATCH).map((p) => makeTab(p.group, p.spec))
      refreshUI()
      if (!activated) {
        const hit = batchTabs.find((t) => t.id === targetActiveId)
        if (hit) {
          activeTabId = hit.id
          activateUI(hit.id)
          activated = true
        }
      }
      await Promise.all(batchTabs.map((t) => spawnTabPty(t)))
    }
  } finally {
    flushHistoryBatch()
  }
  scheduleSave()
  return pending.length
}

export async function restoreSavedWorkspace(wsId: string): Promise<void> {
  const w = savedWorkspaces.find((x) => x.id === wsId)
  if (!w) return
  const tabCount = w.snapshot.groups.reduce((n, g) => n + g.tabs.length, 0)
  confirmDialog({
    title: t('恢复工作区「{0}」', w.name),
    message:
      t('即将追加恢复 <b>{0}</b> 个分组、<b>{1}</b> 个标签到当前工作区。<br>已打开的同分组不会被覆盖，只会补齐缺失的标签。', w.snapshot.groups.length, tabCount),
    okLabel: t('恢复'),
    danger: false,
    onOk: async () => {
      const n = await restoreSnapshotGroups(w.snapshot.groups, w.snapshot.activeTabId)
      w.lastRestoredAt = new Date().toISOString()
      refreshUI()
      scheduleSave()
      toast(t('已恢复工作区「{0}」的 {1} 个新标签', w.name, n))
    }
  })
}

export function restoreWorkspaceGroup(wsId: string, groupId: string): void {
  const w = savedWorkspaces.find((x) => x.id === wsId)
  const sg = w?.snapshot.groups.find((g) => g.id === groupId)
  if (!sg) return
  void restoreSnapshotGroups([sg], null).then((n) => {
    toast(t('已恢复分组「{0}」的 {1} 个新标签', sg.name, n))
  })
}

export function deleteWorkspaceGroup(wsId: string, groupId: string): void {
  const w = savedWorkspaces.find((x) => x.id === wsId)
  if (!w) return
  const idx = w.snapshot.groups.findIndex((g) => g.id === groupId)
  if (idx < 0) return
  w.snapshot.groups.splice(idx, 1)
  refreshUI()
  scheduleSave()
}

export function renameSavedWorkspace(wsId: string, newName: string): void {
  const w = savedWorkspaces.find((x) => x.id === wsId)
  if (!w) return
  const nm = newName.trim()
  if (!nm || nm === w.name) return
  w.name = nm
  refreshUI()
  scheduleSave()
}

export function deleteSavedWorkspace(wsId: string): void {
  const idx = savedWorkspaces.findIndex((x) => x.id === wsId)
  if (idx < 0) return
  const w = savedWorkspaces[idx]
  confirmDialog({
    title: t('删除已保存的工作区'),
    message: t('确定删除「{0}」？<br>只删除这份工作区留档，不会删除任何分组和标签页。', escapeHtml(w.name)),
    okLabel: t('删除'),
    danger: true,
    onOk: () => {
      savedWorkspaces.splice(idx, 1)
      refreshUI()
      scheduleSave()
    }
  })
}

export function openWorkspacePaneCtx(x: number, y: number): void {
  showCtxMenu(
    [
      {
        label: t('保存该工作区'),
        icon: icon('rotate-ccw'),
        act: () => promptSaveWorkspace()
      }
    ],
    x, y
  )
}

export function getGroupViews(): GroupView[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    cwd: g.cwd,
    collapsed: g.collapsed,
    tabs: g.tabs,
    dirty: isGroupDirty(g)
  }))
}

// 侧边栏快捷区按「最近动过」倒序；管理页按名称排序，两处刻意不同。
export function getSavedViews(): SavedView[] {
  return [...savedGroups]
    .sort((a, b) => recencyDesc(a.lastRestoredAt ?? a.savedAt, b.lastRestoredAt ?? b.savedAt))
    .map((s) => ({
      id: s.id,
      name: s.name,
      cwd: shortPath(s.cwd),
      tabCount: s.snapshot.tabs.length,
      savedAt: formatTs(s.savedAt)
    }))
}

export function getSavedWorkspaceViews(): SavedWorkspaceView[] {
  return [...savedWorkspaces]
    .sort((a, b) => recencyDesc(a.lastRestoredAt ?? a.savedAt, b.lastRestoredAt ?? b.savedAt))
    .map((w) => ({
      id: w.id,
      name: w.name,
      savedAt: formatTs(w.savedAt),
      groupCount: w.snapshot.groups.length,
      tabCount: w.snapshot.groups.reduce((n, g) => n + g.tabs.length, 0)
    }))
}

export function reorderGroups(ids: string[]): void {
  const map = new Map(groups.map((g) => [g.id, g]))
  const next: Group[] = []
  for (const id of ids) {
    const g = map.get(id)
    if (g) next.push(g)
  }
  for (const g of groups) if (!ids.includes(g.id)) next.push(g)
  groups.splice(0, groups.length, ...next)
  refreshUI()
}

// 外部切模型/思考强度：往活跃 tab 的 cc 注入斜杠命令；无活跃会话或 cc 正忙（busy/attention）拒绝。
function activeCcTabForInject(): TerminalTab | null {
  const ctx = activeContext()
  if (!ctx) return null
  const { tab } = ctx
  if (tab.ptyId == null || !tab.activeSessionId) {
    toast(t('当前标签没有活跃的 Claude 会话'))
    return null
  }
  if (tab.status === 'busy' || tab.status === 'attention') {
    toast(t('Claude 正忙，请等当前回合结束再切换'))
    return null
  }
  return tab
}

// 先 Ctrl-U(\x15) 清掉输入行里可能的半截文字，避免和命令拼在一起；再发命令 + 回车。
function injectSlash(tab: TerminalTab, line: string): void {
  window.term.send(tab.ptyId!, '\x15' + line + '\r')
  tab.term.focus()
  busEmit('sessionInfo:nudge') // 模型/effort 由 cc statusline 秒级回报，催一次让状态栏早点回显
}

// /model 带参直接切；cc 会存成新会话默认，切一次即持久。
export function switchActiveModel(arg: string, label: string): void {
  const tab = activeCcTabForInject()
  if (!tab) return
  injectSlash(tab, '/model ' + arg)
  toast(t('已切换模型 → {0}', label))
}

// /effort 带参直接设当前会话思考强度（不持久，属会话级）。
export function switchActiveEffort(level: string): void {
  const tab = activeCcTabForInject()
  if (!tab) return
  injectSlash(tab, '/effort ' + level)
  toast(t('已切换思考强度 → {0}', level))
}

// Ctrl+S 保存当前脏分组：终端聚焦时由 TerminalTab 键处理器调（拦掉 XOFF），其余走 window keydown 兜底。
export function saveActiveDirtyGroup(): void {
  const g = groups.find((x) => x.tabs.some((t) => t.id === activeTabId))
  if (!g) return
  if (!isGroupDirty(g)) {
    toast(t('「{0}」没有未保存的改动', g.name))
    return
  }
  saveGroup(g.id)
}

function lastTsOf(t: SavedTab): string | undefined {
  let best: string | undefined
  for (const s of t.sessions) {
    const v = s.lastTs ?? s.createdAt
    if (!best || v > best) best = v
  }
  return best
}

export function getManageGroupViews(): ManageGroupView[] {
  return [...savedGroups]
    .sort((a, b) => naturalNameCompare(a.name, b.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      savedAt: s.savedAt,
      tabs: s.snapshot.tabs.map((t) => {
        const activeId = t.activeSessionId ?? t.sessions[t.sessions.length - 1]?.sessionId
        return {
          id: t.id,
          name: t.name,
          sessions: t.sessions.map((se) => ({
            sessionId: se.sessionId,
            title: sessionTitle(se, t.sessions),
            hasUserTitle: !!se.userTitle,
            source: se.source,
            ts: se.lastTs ?? se.createdAt,
            isActive: se.sessionId === activeId
          })),
          savedAt: t.savedAt,
          lastTs: lastTsOf(t)
        }
      })
    }))
}

export function getManageWorkspaceViews(): ManageWorkspaceView[] {
  return [...savedWorkspaces]
    .sort((a, b) => naturalNameCompare(a.name, b.name))
    .map((w) => ({
      id: w.id,
      name: w.name,
      savedAt: w.savedAt,
      groupCount: w.snapshot.groups.length,
      tabCount: w.snapshot.groups.reduce((n, g) => n + g.tabs.length, 0),
      groups: w.snapshot.groups.map((g) => ({
        id: g.id,
        name: g.name,
        cwd: g.cwd,
        tabCount: g.tabs.length
      }))
    }))
}

function manageRenameSaved(id: string, name: string): void {
  const s = savedGroups.find((x) => x.id === id)
  if (!s) return
  s.name = name
  s.snapshot.name = name
  dedupSavedByNameCwd()
  refreshUI()
  scheduleSave()
}

function manageDeleteSaved(id: string): void {
  const s = savedGroups.find((x) => x.id === id)
  if (!s) return
  confirmDialog({
    title: t('删除已保存的「{0}」？', s.name),
    message: t('会删除该分组下的所有标签页。只动保存记录，已打开的实例不受影响。'),
    okLabel: t('删除'),
    onOk: () => {
      const idx = savedGroups.findIndex((x) => x.id === id)
      if (idx >= 0) savedGroups.splice(idx, 1)
      refreshUI()
      scheduleSave()
      toast(t('已删除保存的分组'))
    }
  })
}

function manageRenameSavedTab(savedId: string, tabId: string, newName: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  const t = s.snapshot.tabs.find((x) => x.id === tabId)
  if (!t || t.name === newName) return
  t.name = newName
  // 同步到已打开的同 id 标签（若存在），保持命名一致
  for (const g of groups) {
    const live = g.tabs.find((x) => x.id === tabId)
    if (live) { live.name = newName }
  }
  refreshUI()
  scheduleSave()
}

function manageDeleteSavedTab(savedId: string, tabId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  const idx = s.snapshot.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) return
  s.snapshot.tabs.splice(idx, 1)
  refreshUI()
  scheduleSave()
}

function restoreSavedOneTab(savedId: string, tabId: string): void {
  void restoreSavedTabs(savedId, [tabId])
}

// 会话级恢复（入口②·管理页）：恢复该标签页，但把活跃会话指定为 sessionId（会话栈整份带过来）
function restoreSavedTabAtSession(savedId: string, tabId: string, sessionId: string): void {
  void restoreSavedTabs(savedId, [tabId], undefined, undefined, new Map([[tabId, sessionId]]))
}

export const savedManagerApi = {
  onRename: manageRenameSaved,
  onDelete: manageDeleteSaved,
  onRenameTab: manageRenameSavedTab,
  onDeleteTab: manageDeleteSavedTab,
  onRestoreAll: restoreSavedAll,
  onRestoreSelect: openRestoreSelect,
  onRestoreOneTab: restoreSavedOneTab,
  onRestoreTabAtSession: restoreSavedTabAtSession,
  onAddTabToSaved: addTabToSavedGroup,
  onRenameWorkspace: renameSavedWorkspace,
  onDeleteWorkspace: deleteSavedWorkspace,
  onRestoreWorkspace: (id: string): void => void restoreSavedWorkspace(id),
  onRestoreWorkspaceGroup: restoreWorkspaceGroup,
  onDeleteWorkspaceGroup: deleteWorkspaceGroup
}

export async function restoreFromHistory(entry: HistoryEntry): Promise<void> {
  let g = groups.find((x) => x.cwd === entry.cwd)
  if (!g) g = ensureGroup({ name: entry.groupName || entry.cwd, cwd: entry.cwd })
  if (g.tabs.some((t) => t.id === entry.tabId)) {
    activeTabId = entry.tabId
    activateUI(entry.tabId)
    toast(t('已切到「{0}」', entry.tabName))
    return
  }
  // tabId 已在保存快照里：视为"回到已保存位置"，不打脏，由 autoSync 拉齐快照。
  // saved 匹配必须走 findSavedForGroup（name+cwd 兜底）并重绑 srcId，否则新建分组的 srcId 对不上。
  const saved = findSavedForGroup(g)
  if (saved) saved.srcId = g.id
  const knownInSaved = !!saved?.snapshot.tabs.some((t) => t.id === entry.tabId)
  const tab = makeTab(g, {
    id: entry.tabId,
    name: entry.tabName,
    sessions: entry.sessions,
    activeSessionId: entry.activeSessionId,
    autoLaunchCC: entry.autoLaunchCC,
    memo: entry.memo,
    dirty: !knownInSaved
  })
  if (knownInSaved) autoSyncTabToSaved(tab, g)
  activeTabId = tab.id
  refreshUI()
  activateUI(tab.id)
  await spawnTabPty(tab)
  scheduleSave()
  toast(t('已从历史恢复「{0}」', entry.tabName))
}

// ─── 跨窗口标签迁移（拖出成独立窗口 / 拖回合并） ─────────────────
// 主进程（windows.ts）协调；本窗口实现两端：export（打包+detach）与 import（重建+adopt）。

// 副窗口（URL 带 ?secondary=1）：不消费 open-here、不管悬浮窗开关，迁空后自动关闭。
export const isSecondary = new URLSearchParams(location.search).has('secondary')

let myWindowId = -1
export function getWindowId(): number { return myWindowId }

type TabTransferPayload = Parameters<Parameters<typeof window.term.onTabImport>[0]>[0]

// 源端：打包 tab 完整状态 + serialize 终端画面 + 本地摘除（不杀 PTY）。
// 时序关键：先 ptyHold（主进程开始暂存该 PTY 输出）再 serialize——快照与队列无缝衔接不丢字节。
async function exportTabForTransfer(tabId: string): Promise<TabTransferPayload | null> {
  const ctx = findTab(tabId)
  if (!ctx) return null
  const { group, tab } = ctx
  if (tab.ptyId != null) {
    try { await window.term.ptyHold(tab.ptyId) } catch {}
    // hold 后 IPC 在途的 pty:data 还要先落进 xterm，等一个宏任务再 serialize
    await new Promise<void>((r) => setTimeout(r, 0))
  }
  const payload: TabTransferPayload = {
    tab: {
      id: tab.id,
      name: tab.name,
      cwd: tab.cwd,
      sessions: tab.sessions.map((s) => ({ ...s })),
      activeSessionId: tab.activeSessionId,
      autoLaunchCC: tab.autoLaunchCC,
      status: tab.status,
      note: tab.note,
      memo: tab.memo,
      dirty: tab.dirty,
      ccActive: tab.ccActive
    },
    group: { id: group.id, name: group.name, cwd: group.cwd },
    ptyId: tab.ptyId,
    buffer: tab.serializeBuffer()
  }
  // 本地摘除：detach 销毁 xterm/DOM 但保留 PTY 进程；分组空了连分组一起移除
  const idx = group.tabs.indexOf(tab)
  if (idx >= 0) group.tabs.splice(idx, 1)
  tab.detach()
  if (downgradeTabId === tabId) clearDowngradeTimer()
  if (activeTabId === tab.id) {
    const next = pickNextActive(group, idx)
    activeTabId = next?.id ?? null
    if (next) activateUI(next.id)
  }
  if (group.tabs.length === 0) {
    const gi = groups.indexOf(group)
    if (gi >= 0) groups.splice(gi, 1)
  }
  refreshUI()
  scheduleSave()
  // 迁空自动关窗由主进程负责：此刻路由表未 release，渲染层自关会被误拦且可能丢迁移数据
  return payload
}

// 目标端：重建分组（同 id → 同名同 cwd → 新建）、重建 xterm、写回画面、接管 PTY，再切路由回放队列。
function importTransferredTab(p: TabTransferPayload): void {
  let g = findGroup(p.group.id)
    || groups.find((x) => x.name === p.group.name && x.cwd === p.group.cwd)
  if (!g) {
    g = { id: p.group.id, name: p.group.name, cwd: p.group.cwd, collapsed: false, tabs: [] }
    groups.push(g)
    // 已保存记录重绑 srcId（与 restoreSnapshotGroups 同语义），isGroupDirty/autoSync 才认得
    const saved = findSavedForGroup(g)
    if (saved) saved.srcId = g.id
  }
  const tab = makeTab(g, {
    id: p.tab.id,
    name: p.tab.name,
    sessions: p.tab.sessions,
    activeSessionId: p.tab.activeSessionId,
    autoLaunchCC: p.tab.autoLaunchCC,
    status: p.tab.status as TerminalTab['status'],
    note: p.tab.note,
    memo: p.tab.memo,
    dirty: p.tab.dirty,
    ccActive: p.tab.ccActive
  })
  g.collapsed = false
  // 先写回画面快照，再接管 PTY；后续增量输出由主进程回放暂存队列衔接
  if (p.buffer) {
    try { tab.term.write(p.buffer) } catch {}
  }
  if (p.ptyId != null) tab.adoptPty(p.ptyId)
  window.term.tabImportDone(tab.id, p.ptyId)
  activeTabId = tab.id
  refreshUI()
  activateUI(tab.id) // setActive 的 rAF refit 会把新窗口真实尺寸推给 PTY（cc 收 SIGWINCH 重画）
  scheduleSave()
  toast(t('已移入标签「{0}」', tab.name))
  // 迁移前 shell 已退出（无 PTY）：直接重启一个（launchCC 会按 activeSessionId 走 resume）
  if (p.ptyId == null) void spawnTabPty(tab)
}

// UI 入口①：拖出窗口外松手 / 右键「移到新窗口」。松手点落在现有窗口内时主进程静默忽略。
export async function moveTabToNewWindow(tabId: string, screenX?: number, screenY?: number): Promise<void> {
  try {
    const res = await window.term.tabMoveToWindow({ tabId, screenX, screenY })
    if (!res.ok && res.error && res.error !== 'inside window' && res.error !== 'migrating') {
      toast(t('移动标签失败：{0}', res.error))
    }
  } catch {}
}

// UI 入口②：另一个窗口的标签被拖到本窗口上松手（拖回/跨窗合并）
export async function moveTabHere(tabId: string): Promise<void> {
  try {
    const res = await window.term.tabMoveToWindow({ tabId, targetWindowId: myWindowId })
    if (!res.ok && res.error && res.error !== 'same window' && res.error !== 'migrating') {
      toast(t('移动标签失败：{0}', res.error))
    }
  } catch {}
}

// 标签拖拽（Sidebar/Toolbar 共用）：Electron 同 app 多窗口 HTML5 拖拽互通，自定义 MIME 传 tabId；没人接住（dropEffect none）→ 拖出成新窗。
export const TAB_DND_MIME = 'application/x-claude-tab'

interface DragEventLike {
  dataTransfer: DataTransfer | null
  screenX: number
  screenY: number
}

export function setTabDragData(e: DragEventLike, tabId: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(TAB_DND_MIME, JSON.stringify({ tabId, windowId: myWindowId }))
}

// dragend：没有 drop 目标接住 → 视为拖出窗口外，请求在松手处开新窗（主进程再校验）。
export function handleTabDragEnd(e: DragEventLike, tabId: string): void {
  if (e.dataTransfer?.dropEffect === 'none') {
    void moveTabToNewWindow(tabId, e.screenX, e.screenY)
  }
}

// drop 目标端：dragover 时调，是跨窗口标签拖拽就声明接住（调用方需 preventDefault）
export function isTabDragOver(dt: DataTransfer | null): boolean {
  if (!dt || !dt.types.includes(TAB_DND_MIME)) return false
  dt.dropEffect = 'move'
  return true
}

// 同分组内标签拖动排序；跨分组不支持（标签 cwd 跟随分组）。
export function moveTabWithinGroup(tabId: string, targetTabId: string, before: boolean): void {
  if (tabId === targetTabId) return
  const src = findTab(tabId)
  const dst = findTab(targetTabId)
  if (!src || !dst || src.group !== dst.group) return
  const tabs = src.group.tabs
  const fromIdx = tabs.indexOf(src.tab)
  if (fromIdx < 0) return
  tabs.splice(fromIdx, 1)
  let toIdx = tabs.indexOf(dst.tab)
  if (toIdx < 0) {
    tabs.splice(fromIdx, 0, src.tab) // 还原
    return
  }
  if (!before) toIdx += 1
  tabs.splice(toIdx, 0, src.tab)
  refreshUI()
}

// drop 落地：本窗口的 tab（窗口内拖动）忽略，交给原有交互；其他窗口的 tab → 迁移过来
export function handleTabDrop(dt: DataTransfer | null): void {
  const raw = dt?.getData(TAB_DND_MIME)
  if (!raw) return
  try {
    const p = JSON.parse(raw) as { tabId: string; windowId: number }
    if (!p?.tabId || p.windowId === myWindowId) return
    void moveTabHere(p.tabId)
  } catch {}
}

// 其他窗口落盘 settings 后的跨窗口同步：只应用不回写（落盘窗口负责持久化与悬浮窗开关）
function applyExternalSettings(s: Settings): void {
  const prevTabBar = settings.tabBarMode
  settings = s
  applySettingsToAll()
  refreshUI()
  if (prevTabBar !== s.tabBarMode) setTimeout(() => refitActive(), 60)
}

export async function preBoot(): Promise<void> {
  settings = await window.term.loadSettings()
  try { myWindowId = await window.term.windowId() } catch {}
  // 语言尽早定死：后续动态渲染的 t() 都依赖它
  setLanguage(settings.language)
  // macOS 红绿灯 / 自绘窗口按钮的显隐由 body.platform-* 的 CSS 适配
  document.body.classList.add(window.term.platform === 'darwin' ? 'platform-mac' : 'platform-win')
}

// saved 数据从磁盘整载（覆盖式）：启动时用，其他窗口落盘广播后也用它刷新本窗口副本。
async function hydrateSavedFromDisk(): Promise<void> {
  const ws = await window.term.loadWorkspace()
  savedGroups.splice(0, savedGroups.length)
  for (const s of ws.savedGroups) {
    savedGroups.push({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      savedAt: s.savedAt,
      lastRestoredAt: s.lastRestoredAt,
      srcId: s.srcId,
      snapshot: {
        name: s.snapshot.name,
        cwd: s.snapshot.cwd,
        tabs: s.snapshot.tabs.map((t) => ({
          id: t.id,
          name: t.name,
          sessions: t.sessions,
          activeSessionId: t.activeSessionId,
          autoLaunchCC: t.autoLaunchCC !== false,
          memo: t.memo,
          savedAt: s.savedAt
        }))
      }
    })
  }
  // 历史数据可能有同名同路径的重复条目（之前没合并），统一收拢
  dedupSavedByNameCwd()
  savedWorkspaces.splice(0, savedWorkspaces.length)
  for (const w of ws.savedWorkspaces ?? []) {
    savedWorkspaces.push({
      id: w.id,
      name: w.name,
      savedAt: w.savedAt,
      lastRestoredAt: w.lastRestoredAt,
      snapshot: {
        activeTabId: w.snapshot.activeTabId ?? null,
        groups: w.snapshot.groups.map((g) => ({
          id: g.id,
          name: g.name,
          cwd: g.cwd,
          tabs: g.tabs.map((t) => ({
            id: t.id,
            name: t.name,
            sessions: t.sessions,
            activeSessionId: t.activeSessionId,
            autoLaunchCC: t.autoLaunchCC !== false,
            memo: t.memo,
            savedAt: w.savedAt
          }))
        }))
      }
    })
  }
  // live 分组与 saved 的绑定重建：磁盘数据覆盖后 srcId 可能对不上本窗口的 live 分组
  for (const g of groups) {
    const saved = savedGroups.find((s) => s.name === g.name && s.cwd === g.cwd)
    if (saved && !findGroup(saved.srcId ?? '')) saved.srcId = g.id
  }
}

// initApp：组件树挂载后跑一次。只读 saved 数据，live 分组不恢复——启动即空状态。
export async function initApp(): Promise<void> {
  await hostsReady

  // ─── PTY 全局路由 ───────────────────────────────────────────────
  const offData = window.term.onData((id, data) => {
    for (const g of groups) for (const t of g.tabs) if (t.ptyId === id) return t.writeFromPty(data)
  })
  const offExit = window.term.onExit((id, exitCode) => {
    for (const g of groups) for (const t of g.tabs) if (t.ptyId === id) return t.handlePtyExit(exitCode)
  })

  // ─── 会话事件压栈 ───────────────────────────────────────────────
  // resume 会让旧 sessionId 再发 SessionStart：按 sessionId 去重，命中只切激活
  const offSession = window.term.onSessionEvent((ev) => {
    // cc 已起来 → 提前释放启动闸门坑位（晚于兜底超时到达则为 no-op）
    ccGateRelease(ev.tabId)
    const ctx = findTab(ev.tabId)
    if (!ctx) return
    const { tab } = ctx
    // SessionStart 到达即 cc 刚起了会话 → 标记活跃。cc 退出后由 onShellCommand 翻回 false。
    tab.ccActive = true
    // 清掉历史累积的同 id 重复条目（早期版本无去重）
    if (tab.sessions.length > 1) {
      const seen = new Set<string>()
      tab.sessions = tab.sessions.filter((s) => {
        if (seen.has(s.sessionId)) return false
        seen.add(s.sessionId)
        return true
      })
    }
    const existedIdx = tab.sessions.findIndex((s) => s.sessionId === ev.sessionId)
    if (existedIdx >= 0) {
      const [existed] = tab.sessions.splice(existedIdx, 1)
      if (ev.ts && (!existed.lastTs || ev.ts > existed.lastTs)) existed.lastTs = ev.ts
      // resume 旧会话挪到数组末尾（栈顶），反映"最近活跃"次序
      tab.sessions.push(existed)
      tab.activeSessionId = ev.sessionId
      autoSyncTabToSaved(tab, ctx.group)
      scheduleSave()
      refreshUI()
      recordTabHistory(tab, ctx.group.name, true)
      return
    }
    tab.sessions.push({
      sessionId: ev.sessionId,
      source: ev.source,
      createdAt: ev.ts || new Date().toISOString()
    })
    tab.activeSessionId = ev.sessionId
    // 栈内新增（/clear、/new、resume）不打 dirty；若 group 已保存，静默同步到快照
    autoSyncTabToSaved(tab, ctx.group)
    scheduleSave()
    refreshUI()
    void refreshSessionMeta(tab)
    recordTabHistory(tab, ctx.group.name, true)
  })

  // ─── 状态徽标事件 ───────────────────────────────────────────────
  const offState = window.term.onStateEvent((ev) => {
    const ctx = findTab(ev.tabId)
    if (!ctx) return
    // 外部 hook 不许把 done/attention 盖成 idle——降级是渲染层倒计时的独占权；
    // 否则 cc 的 idle_prompt 会把绿点静默盖成灰点（历史翻过车，此闸防回归）
    if (ev.state === 'idle' && (ctx.tab.status === 'done' || ctx.tab.status === 'attention')) {
      return
    }
    ctx.tab.status = ev.state
    ctx.tab.note = ev.message
    // 状态变了 → 重置该 tab 之前未触发的降级；若仍是当前 tab 且新态需降级，重启倒计时
    if (ev.tabId === downgradeTabId) clearDowngradeTimer()
    if (activeTabId === ev.tabId) maybeStartDowngrade(ev.tabId, ev.state)
    scheduleSave()
    refreshUI()
  })

  // 查看降级的焦点门（见 maybeStartDowngrade 注释）
  window.addEventListener('blur', clearDowngradeTimer)
  window.addEventListener('focus', resumeDowngradeIfNeeded)

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearchOverlay()
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      // 输入框 / 行内改名里不抢 Ctrl+S
      const t = e.target as HTMLElement
      if (!(t instanceof HTMLInputElement) && !t.closest?.('[contenteditable="true"]')) {
        e.preventDefault()
        saveActiveDirtyGroup()
      }
    }
    // Ctrl+F 兜底：终端聚焦时由 TerminalTab 键处理器开搜索，这里补焦点在侧栏等处的情况
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      const t = e.target as HTMLElement
      if (!(t instanceof HTMLInputElement) && !t.closest?.('[contenteditable="true"]')) {
        e.preventDefault()
        openSearchOverlay()
      }
    }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const all = groups.flatMap((g) => g.tabs)
      if (all.length < 2) return
      const idx = all.findIndex((t) => t.id === activeTabId)
      const next = e.shiftKey ? all[(idx - 1 + all.length) % all.length] : all[(idx + 1) % all.length]
      activateTab(next.id)
    }
  })

  window.addEventListener('beforeunload', () => {
    offData()
    offExit()
    offSession()
    offState()
    for (const g of groups) for (const t of g.tabs) t.dispose()
  })

  window.term.onWindowCloseRequest(() => {
    if (isConfirmOpen()) return // 已有确认弹窗在显示，忽略重复触发
    const dirtyGroups = groups.filter((g) => isGroupDirty(g) && g.tabs.length > 0)
    const showDirty = dirtyGroups.length > 0
    if (showDirty) {
      const lines = dirtyGroups
        .map((g) => t('• <b>{0}</b>（{1} 个标签）', escapeHtml(g.name), g.tabs.length))
        .join('<br/>')
      confirmDialog({
        title: t('有未保存的分组，仍要关闭？'),
        message: t('以下分组未保存，关闭后将丢失标签布局：<br/>{0}<br/><br/>可先在分组右键「保存分组」，或直接关闭。', lines),
        okLabel: t('仍然关闭'),
        onOk: () => window.term.winConfirmClose()
      })
      return
    }
    confirmDialog({
      title: isSecondary ? t('确认关闭此窗口？') : t('确认关闭 Claude Terminal？'),
      message: isSecondary
        ? t('关闭后该窗口内的终端会话将被终止。确认继续？')
        : t('关闭后所有终端会话将被终止。确认继续？'),
      okLabel: t('关闭'),
      onOk: () => window.term.winConfirmClose()
    })
  })

  // ─── 跨窗口标签迁移（主/副窗口都要注册：任一窗口都可能是源或目标） ──
  window.term.onTabExportRequest((req) => {
    void exportTabForTransfer(req.tabId)
      .then((payload) => window.term.tabExportReply(req.reqId, payload))
      .catch(() => window.term.tabExportReply(req.reqId, null))
  })
  window.term.onTabImport((p) => {
    try { importTransferredTab(p) } catch (e) { console.error('[migrate] import failed', e) }
  })
  // 其他窗口落盘引发的同步：settings 直接应用；savedGroups 从磁盘重载副本
  window.term.onSettingsChanged((s) => applyExternalSettings(s))
  window.term.onWorkspaceChanged(() => void hydrateSavedFromDisk().then(refreshUI))

  // ─── 启动恢复 ───────────────────────────────────────────────────
  await hydrateSavedFromDisk()
  refreshUI()
  if (isSecondary) {
    // 副窗口只上报 ready，主进程随即开始向本窗口 import
    window.term.secondaryReady()
    return
  }
  window.term.floaterSetEnabled(settings.showFloater)
  if (settings.showFloater) pushFloaterCounts()
  // 悬浮窗右键"隐藏"后主进程已落盘 showFloater=false，这里同步内存副本
  window.term.onFloaterHidden(() => {
    if (!settings.showFloater) return
    settings = { ...settings, showFloater: false }
  })
  // second-instance 的 open-here：主进程解析 argv 后推 path 过来
  window.term.onOpenHere((p) => {
    void openHereWithPath(p)
  })
  // 首次启动的 --open-here 用 invoke 主动拉：send 推送会在监听器注册前送达被丢
  try {
    const pending = await window.term.consumePendingOpenHere()
    for (const p of pending) void openHereWithPath(p)
  } catch {}
}
