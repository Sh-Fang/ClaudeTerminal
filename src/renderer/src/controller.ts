// controller.ts —— 业务核心（原 main.ts 全量移植，React 迁移后 UI 渲染交给组件树）。
// 状态仍是"就地可变 + 显式刷新"模式：任何改动后调 refreshUI()（= store bump + 悬浮窗计数推送），
// 订阅 rev 的组件重拉 getter 数据。弹窗/菜单/toast 走 state/overlays 的命令式 API（签名与原
// ui-helpers 一致）；会话信息条的 nudge 走事件总线 busEmit。
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

// 类型 re-export：组件统一从 controller 拿视图类型（app-types 亦可）
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

// ─── hosts 元素（TerminalHosts 组件挂载后注入） ────────────────────
// xterm 命令式挂载的宿主容器。React 组件 ref 就绪后调 setHostsEl；initApp 开头
// await hostsReady，保证恢复标签时 hostsEl 一定可用。
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

// ─── 状态 ───────────────────────────────────────────────────────────
export interface Group {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

// 标签是否"承载 cc"：勾了自动启动 cc，或实际已经起过 cc 会话（含手动 cct / claude 起的）。
// 关键：autoLaunchCC 只是"新建时的意图"，cct 手动起的会话 autoLaunchCC=false 却有真实会话
// 价值——只看 autoLaunchCC 会把这种 tab 误判成纯 pwsh，dirty / 关闭确认全部漏掉。
export function isCcTab(t: TerminalTab): boolean {
  return t.autoLaunchCC || t.sessions.length > 0
}

// 纯 pwsh 分组：所有标签既没勾"自动启动 cc"、也没起过任何 cc 会话。本质就是普通终端，
// 关掉就关掉、下次重开就是空白，没有保存价值。
function isPureNonCcGroup(g: Group): boolean {
  return g.tabs.length > 0 && g.tabs.every((t) => !isCcTab(t))
}

// 单个标签是否"可丢弃"：不承载 cc（没勾自动启动、也没有任何会话栈记录）。
// 关闭这种标签不会丢失任何 cc 会话历史，跳过二次确认更顺手。
function isTabExpendable(t: TerminalTab): boolean {
  return !isCcTab(t)
}

// 分组是否"脏"：组内有承载 cc 的未保存标签，或组元信息（name/cwd）与已保存的不一致，
// 或根本没有对应的已保存条目。纯 pwsh 分组永远视为"不脏"——没东西可保存。
function isGroupDirty(g: Group): boolean {
  if (isPureNonCcGroup(g)) return false
  // 只有"承载 cc"的 tab 的 dirty 才传染到分组——纯 pwsh tab 改了也无所谓。
  // 用 isCcTab 而非 autoLaunchCC：cct 手动起的会话（autoLaunchCC=false）也要能让分组显 dirty。
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

// 悬浮窗：统计 done / attention / busy 标签数 + 已打开分组下的标签总数。
// 全 0 时悬浮窗自行退回展示 total（标签数），这里只负责老老实实推数。
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

// 统一刷新入口：原 sidebar.render()/toolbar.render()/savedManager.render() 全部汇聚到这里。
// bump 让订阅 rev 的组件重渲染；悬浮窗计数原来包在 sidebar.render 外层，一并跟着刷。
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
  // 主题/标签栏布局/终端背板等由 App 与组件按 settings 派生；这里只负责刷新与联动
  // 设置里可能改了「已保存分组显示数量」，重渲染让侧边栏与管理弹窗即时反映
  refreshUI()
  // 布局在垂直/水平之间切换会改变终端可用宽度 —— 布局稳定后重排一次，避免尺寸错位
  if (prevTabBar !== settings.tabBarMode) {
    setTimeout(() => activeContext()?.tab.refit(), 60)
  }
  if (prevFloater !== settings.showFloater) {
    window.term.floaterSetEnabled(settings.showFloater)
  }
  if (settings.showFloater) pushFloaterCounts()
  // 去抖落盘（含主进程归一化后回写，可能 clamp 了字段，保持本地一致）——与 persistSettings 同逻辑
  persistSettings()
}

// 就地合并（不落盘不刷新）：侧边栏拖宽度 / 已保存区拖高度过程中高频调用，
// 拖完由调用方自己 persistSettings。
export function patchSettingsLive(p: Partial<Settings>): void {
  settings = { ...settings, ...p }
}

export function persistSettings(): void {
  if (settingsSaveTimer != null) window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null
    // 合并而非整体替换：主进程若是旧构建（归一化白名单没有新字段），
    // 整体替换会把渲染层刚写入的新字段悄悄抹掉（表现为"设置不生效/回跳"）
    void window.term.saveSettings(settings).then((normed) => { settings = { ...settings, ...normed } })
  }, 300)
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

const IS_WIN_PLATFORM = window.term.platform === 'win32'

// 平台感知的 shell 引号：Windows 走 pwsh（单引号内 '' 转义），
// macOS/类 Unix 走 POSIX（单引号内 '\'' 转义）。用于把绝对路径 / tab 名安全拼进命令行。
function quoteShell(s: string): string {
  return IS_WIN_PLATFORM
    ? `'${s.replace(/'/g, "''")}'`
    : `'${s.replace(/'/g, "'\\''")}'`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 判断 shell-integration 上报的命令行是不是「启动 cc」——命中就跳过 shell-busy 标注，
// 让 cc 自己的 hooks 单独驱动 busy/attention/done/error。
// 覆盖：`claude ...`、`& 'C:\...\claude.exe' ...`、`& claude ...`、`cct ...`（本 app pwsh
// profile 注入的函数，内部就是启动可接管的 cc），以及用户在 settings 里指定的 claudePath
// basename（改名后的 cc 也能识别）。扩展名 .exe/.cmd/.ps1/.bat 视为等价。
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

// ─── 寻找 / 当前激活 ───────────────────────────────────────────────
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

// 当前活跃 tab 重排（原 ResizeObserver / 布局切换后的 refit 汇聚点，供组件调用）
export function refitActive(): void {
  activeContext()?.tab.refit()
}

// Toolbar 组件的数据源（原 Toolbar hooks 的 getActiveTab）
export function getToolbarCtx(): { tab: TerminalTab; groupName: string; groupCwd: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
}

// SessionInfoBar 组件的数据源（原 SessionInfoBar hooks 的 getActive）
export function getSessionInfoCtx(): { sessionId: string | null; cwd: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { sessionId: ctx.tab.activeSessionId ?? null, cwd: ctx.group.cwd }
}

// ─── 持久化 ────────────────────────────────────────────────────────
// 轻量模式：只持久化已保存的分组（savedGroups），当前打开的分组与标签不写盘。
// 用户希望"打开秒开 = 空状态"，未保存的工作随窗口关闭即销毁。
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
            autoLaunchCC: t.autoLaunchCC
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
              autoLaunchCC: t.autoLaunchCC
            }))
          })),
          activeTabId: w.snapshot.activeTabId
        }
      })),
      activeTabId
    })
  }, 300)
}

// ─── 标签历史落底 ──────────────────────────────────────────────────
// 每次"打开标签 / 激活标签 / 会话栈变化"都把 tab 当前状态写入历史，给崩溃后找回用。
// 写盘走主进程同步落盘（atomic rename），调用频率上靠这里做轻量节流：同一 tab 1.5s 内
// 至多写一次（除非强制）；新建/恢复/会话事件等关键时机用 force=true 立刻落。
const historyFlushAt = new Map<string, number>()
function recordTabHistory(tab: TerminalTab, groupName: string, force = false): void {
  const now = Date.now()
  const last = historyFlushAt.get(tab.id) ?? 0
  if (!force && now - last < 1500) return
  historyFlushAt.set(tab.id, now)
  void window.term.tabHistoryUpsert({
    tabId: tab.id,
    tabName: tab.name,
    groupName,
    cwd: tab.cwd,
    autoLaunchCC: tab.autoLaunchCC,
    sessions: tab.sessions.map((s) => ({ ...s })),
    activeSessionId: tab.activeSessionId,
    openedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  })
}

// ─── 启动 cc ───────────────────────────────────────────────────────
async function launchCC(tab: TerminalTab): Promise<void> {
  if (!tab.autoLaunchCC) return
  if (tab.ptyId == null) return

  const claudeBin = settings.claudePath.trim()
  if (claudeBin) {
    // 自定义路径：先校验文件存在
    if (!(await window.term.pathExists(claudeBin))) {
      tab.term.writeln(`\x1b[33m${t('[claude 路径不存在：{0}，跳过自动启动]', claudeBin)}\x1b[0m`)
      tab.term.writeln(`\x1b[90m${t('请到设置 → Claude Code 中重新选择 claude 可执行文件。')}\x1b[0m`)
      return
    }
  } else {
    const available = await window.term.claudeAvailable()
    if (!available) {
      tab.term.writeln(`\x1b[90m${t('[claude 未在 PATH 中，跳过自动启动 Claude Code]')}\x1b[0m`)
      return
    }
  }
  // 自定义路径走平台引号；默认走裸 claude（让 shell 自己解析）
  const claudeCmd = claudeBin ? quoteShell(claudeBin) : 'claude'
  // Windows(pwsh)：带空格/反斜杠的绝对路径要加 & 调用操作符才执行；
  // POSIX(zsh/bash)：引号包住的绝对路径可直接执行，无需前缀。
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
    // 设置里选了默认模型 → 新会话开局带上 --model；--resume 分支刻意不带，
    // 避免覆盖旧会话原有模型（cc 恢复后仍走它自己保存的默认，用户想改用左下芯片手动切）。
    // 只允许字母数字/-/./_，防注入（同时也能挡住"跟随 cc 默认"的空串）
    const model = settings.defaults.model
    const modelArg = /^[A-Za-z0-9._-]+$/.test(model) ? ` --model ${model}` : ''
    cmd = `${invoker}${claudeCmd} --session-id ${newId} --name ${quoteShell(tab.name)}${modelArg}${settingsArg}`
  }
  window.term.send(tab.ptyId, cmd + '\r')
}

// 顶栏"启动 CC"按钮入口：在当前纯 pwsh 标签里手动起一次可被 app 接管的 cc 会话。
// 等效于用户手敲 cct（走 shell profile 里的 cct 函数：--session-id 新 uuid --name <tab>
// --settings <hooks>），给不知道 cct 命令的用户一个可视化入口；hook 上报后 onSessionEvent 压栈接管。
export function startCcInActiveTab(): void {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (isCcTab(tab)) return       // 已勾自动启动或已起过会话 → 不重复起
  if (tab.ptyId == null) return  // pty 还没就绪
  window.term.send(tab.ptyId, 'cct\r')
  tab.term.focus()
}

// ─── Tab 工厂 ─────────────────────────────────────────────────────
function makeTab(group: Group, opts: {
  id?: string
  name: string
  sessions?: SessionRecord[]
  activeSessionId?: string
  autoLaunchCC?: boolean
  status?: TerminalTab['status']
  note?: string
  dirty?: boolean
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
      // cc 接口异常兜底：terminal-tab 扫到 API Error 时已把 status 置成 error，
      // 这里补上 note 并刷新侧栏/顶栏（红点，需用户手动"标记为已查看"清除）。
      onErrorDetected: (note) => {
        tabRef.note = note
        refreshUI()
      },
      onShellCommand: (kind, cmd) => {
        // pwsh shell integration OSC 序列触发 → pwsh 一定在前台（cc 全屏 TUI 会完全屏蔽这些序列）。
        // 顶栏"启动 CC"按钮据此显隐：cc 退出后 pwsh 打 prompt 触发一次 end → 按钮秒回。
        if (tabRef.ccActive) {
          tabRef.ccActive = false
          refreshUI()
        }
        // A: cc tab（autoLaunchCC=true）状态完全交给 cc hooks，shell 事件不参与，避免重复标注。
        if (tabRef.autoLaunchCC) return
        // B: 过滤命令本身是启动 cc 的情况——用户在纯 pwsh tab 里手打 `claude` 也不上蓝点。
        //   （字符串匹配漏了兜不住的其他形式，就让它按 shell-busy 显示也没关系，无副作用。）
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
        // 状态变化极频繁（每条 pwsh 命令一对），不落 scheduleSave —— 状态本身不会持久化
      }
    }
  )
  group.tabs.push(tabRef)
  tabRef.mount(hostsEl!)
  // 新建/恢复出来的 tab 立刻落历史，崩溃前哪怕一秒没动也能找回
  recordTabHistory(tabRef, group.name, true)
  return tabRef
}

async function spawnTabPty(tab: TerminalTab): Promise<void> {
  // 等 setActive 里那帧 rAF 跑完再 startPty —— 此时 host 已 display:block 完成
  // reflow、fit 算出真实 cols/rows、xterm 已 resize 到位。
  // 否则 PTY 会用 mount 时 display:none 的 80×24 默认尺寸启动，cc 用 80×24 画
  // splash 的同时 rAF refit 把 PTY 改成真实尺寸 → cc 收 SIGWINCH 边画边重排 →
  // splash box-drawing 字符整屏错位（"切走再切回来就正常了"就是这个原因）。
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: awaiting rAF before startPty')
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: rAF done, calling startPty')
  await tab.startPty()
  // 异步刷新 lastTs（首次出现就重渲染）
  void refreshSessionMeta(tab)
}

// 每帧只处理一小批标签的 PTY，批内并发发起、批与批之间让出一帧主线程。
// 目的：避免"N 个标签同步初始化 + 串行等 IPC"堆成一个长任务把 UI 线程占满
// （表现为恢复多标签时掉帧、鼠标拖动卡顿）。
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

// ─── 分组 / 标签 增删改 ───────────────────────────────────────────
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
      // 记住这次选的路径作为下次预填
      if (cwd && cwd !== settings.lastUsedCwd) {
        settings = { ...settings, lastUsedCwd: cwd }
        void window.term.saveSettings(settings)
      }
      scheduleSave()
      toast(t('已新建分组「{0}」', g.name))
    }
  })
}

// 右键菜单"在此处打开 Claude Terminal"入口：直接建 tab，不弹 modal。
// - 同 cwd 已有 live 分组 → 直接往里新建 tab（tab 名为分组内下一个字母）
// - 否则 ensureGroup(name=basename(path))；若 savedGroups 里有同 name+cwd 的已保存分组，
//   把它的 srcId 绑到新建的 live 分组 —— 这样 isGroupDirty 因为新 tab.id 不在快照里 → 分组头
//   会显示黄色 dirty，用户手动"保存分组"就把新 tab 并进去。
// autoLaunchCC 走设置默认值。
function basenameOfPath(p: string): string {
  // 磁盘根（D:\ / D: / D:/）没有"最后一段"，美化成「D 盘」而不是裸盘符 "D:"
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return t('{0} 盘', drive[1].toUpperCase())
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? p
}

async function openHereWithPath(rawPath: string): Promise<void> {
  const p = (rawPath || '').trim()
  if (!p) return
  // 先校验路径存在，避免右键选中一个已重命名/删除的目录时静默 spawn 失败
  const exists = await window.term.pathExists(p)
  if (!exists) {
    toast(t('路径不存在：{0}', p))
    return
  }
  const bn = basenameOfPath(p) || p
  const cc = settings.defaults.autoLaunchCC
  // 找现成 live 分组（同 cwd 优先复用；无则新建）
  let g = groups.find((x) => x.cwd === p)
  if (!g) {
    g = ensureGroup({ name: bn, cwd: p })
    // 已保存同 name+cwd 的分组自动绑 srcId → 新 tab 让 group 显 dirty
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
  // 把这次选的路径也记成 lastUsedCwd
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

// 管理弹窗里对"已保存分组"直接新增标签：命名窗压在管理弹窗上层，确认后在
// 弹窗后面打开该分组（复用已开实例或按保存记录新建）+ 新标签页 —— 与恢复标签页
// 同一交互；新标签立即写回保存快照（在已保存分组下新建的标签必然"已保存"，不留脏）。
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
      // 复用已打开的同分组实例（srcId → name+cwd 兜底），否则按保存记录新建；
      // 并把保存记录的 srcId 重绑到 live 分组，isGroupDirty / autoSync 才认得
      let g = groups.find((x) => x.id === s.srcId)
        || groups.find((x) => x.name === s.name && x.cwd === s.cwd)
      if (!g) g = ensureGroup({ name: s.name, cwd: s.cwd })
      s.srcId = g.id
      const tab = makeTab(g, { name: v.name, autoLaunchCC: v.autoLaunchCC, dirty: false })
      g.collapsed = false
      activeTabId = tab.id
      activateUI(tab.id)
      await spawnTabPty(tab)
      // 自动保存：新标签立即写入该分组的保存快照
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

// 查看降级：用户切到 done 的标签后，停留 settings.statusDowngradeSec 秒才把状态降回 idle。
// 用意：误点切走时绿点仍保留；真正"我看过了"才消失。
// attention（待决策）不参与降级：决策没做完前该信号一直成立，只能由 cc 发新状态
// （用户回答后 busy→done）或手动"标记为已查看"来清，倒计时无权把它抹成 idle。
//
// 焦点门：用户切到该标签但主窗口在后台（在别的 app 上工作）→ 不应该算"看过了"，
// 不启动倒计时；倒计时进行中失去焦点 → 暂停；回到焦点 → 重新走完整 N 秒。
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

// 焦点回到主窗口：如果当前激活的 tab 正好处于 done，按完整 N 秒重启倒计时（attention 不降级）
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
  // 切走旧 tab → 取消其降级倒计时（保留绿点，下次再切回来重新计时）
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
  if (activeTabId === tab.id) {
    const next = pickNextActive(group, idxInGroup)
    activeTabId = next?.id ?? null
    if (next) activateUI(next.id)
  }
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
    refreshUI()
    scheduleSave()
  }
  // 纯 pwsh 标签且不是分组的最后一个 → 关掉无任何损失，跳过确认
  // （是最后一个仍弹确认，因为会顺带关闭整个分组——这是一个更"重"的操作）
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

// 一键把工作区里全部分组设为收起/展开：全收起只剩分组维度，全展开露出所有标签
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

// 反向定位（类似 IDEA 的 Select Opened File）：在侧边栏里定位当前活动标签。
// 所在分组若收起则只展开这一个分组，其余分组保持原状；随后滚动到该行并闪烁提示。
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
  // React 渲染是异步的：刚展开的分组要等下一次 commit 后行元素才存在，
  // 因此 DOM 查询与闪烁动画延迟到 rAF 里执行（原实现是同步 render 可直接查）。
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
      // 分组元信息变了 → isGroupDirty 会通过 name 与 saved.snapshot.name 不一致自然为 true
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
    savedAt
  }
}

// 自动同步：tab 内部会话栈变化时（/clear、/new、栈内删除），如果其分组已保存，
// 静默把该 tab 在 saved 快照里也覆盖一遍。外部看（分组/标签数）没变就不该 dirty。
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

// 已保存条目之间按 tab.id 去重合并：用户操作期不应出现冲突 id；
// 真有撞 id（早期跨设备数据），保留 savedAt 更新的那条。
function mergeSavedTabLists(a: SavedTab[], b: SavedTab[]): SavedTab[] {
  const map = new Map<string, SavedTab>()
  for (const t of a) map.set(t.id, t)
  for (const t of b) {
    const ex = map.get(t.id)
    if (!ex || (t.savedAt || '') > (ex.savedAt || '')) map.set(t.id, t)
  }
  return [...map.values()]
}

// 同名同路径合并：用户语义上就是一个分组。每次 saveGroup / 启动加载后调用，
// 把重复的 saved 条目并到第一条，避免侧栏出现多个长得一模一样的卡片。
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

// 查找用作"merge 目标"的已存在 saved 条目：先按 srcId 命中（已经绑过的最优），
// 再按 name+cwd 命中（用户改名后又重新保存，或两个 live 分组撞同名）。
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
  // 同步 saved 的 group 元信息（如果与 live 不一致）
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
    for (const t of g.tabs) t.dispose()
    const idx = groups.indexOf(g)
    groups.splice(idx, 1)
    if (activeTabId && !findTab(activeTabId)) {
      const next = groups.flatMap((x) => x.tabs)[0]
      activeTabId = next?.id ?? null
      if (next) activateUI(next.id)
    }
    refreshUI()
    scheduleSave()
    toast(t('已关闭分组「{0}」', g.name))
  }
  // 纯 pwsh 分组 + 无 busy → 直接关闭（保护的是 cc 会话数据，纯 pwsh 没数据可丢）。
  // 其余情况一律二次确认（不再提供关闭确认的开关）。
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

// "勾选恢复" 弹窗里追加的特殊操作项：恢复结束顺手新开一个空白标签。
const PICK_ACTION_NEW_BLANK = '__new_blank__'

// 真正的恢复：按 tabIds 把保存里的标签实例化进 live 分组。
// 已经在 live 分组里（按 id 命中）的标签会被跳过。
// 若 ids 里含 PICK_ACTION_NEW_BLANK，恢复完再 makeTab 一个新空标签，并立刻
// autoSync 到 saved snapshot —— 用户希望"在恢复弹窗里勾的新标签，默认就是已保存"。
export async function restoreSavedTabs(
  savedId: string,
  tabIds: string[],
  blankName?: string,
  blankAutoLaunchCC?: boolean,
  // 会话级恢复(语义 B)：tabId → 指定的活跃会话 sessionId。恢复时覆盖该标签的默认 activeSessionId，
  // 会话栈(sessions[])整份照带；没指定的标签按原 activeSessionId 恢复。
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
  for (const t of picks) {
    if (liveIds.has(t.id)) continue
    const tab = makeTab(g, {
      id: t.id,
      name: t.name,
      sessions: t.sessions,
      activeSessionId: sessionOverride?.get(t.id) ?? t.activeSessionId,
      autoLaunchCC: t.autoLaunchCC,
      dirty: false
    })
    created.push(tab)
  }
  // 新建空白标签：优先用用户输入名，没输入就用字母自动起（与 promptNewTabInGroup 一致）
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
    // 立刻写入 saved snapshot，保持分组"已保存"状态（用户期望：在恢复里新建的默认就保存）
    autoSyncTabToSaved(blank, g)
  }
  // 真正带进来了标签（恢复或新建空白）才算"动过"→ 记恢复时间，把卡片顶到侧边栏最前。
  // 纯 no-op（点恢复但都已打开）不改时间，避免无谓重排。
  if (created.length > 0) s.lastRestoredAt = new Date().toISOString()
  // 恢复后焦点切到刚 created 的第一个 —— 用户语义就是"打开这个保存的分组进去看看"。
  // created 为空（点恢复但所有 tab 已在 live 里）才回退到原有 active / 组内首个。
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
  scheduleSave()
  // toast 文案区分：纯新建 / 恢复+新建 / 纯恢复
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

// 卡片点击 → 弹"选择恢复"对话框（外面的"恢复"默认走这里）
export function openRestoreSelect(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  if (s.snapshot.tabs.length === 0) {
    toast(t('该保存的分组里没有标签'))
    return
  }
  const live = s.srcId ? findGroup(s.srcId) : undefined
  const liveIds = new Set(live?.tabs.map((t) => t.id) ?? [])
  // 会话级恢复(入口①·语义 B)：tabId → 指定的活跃会话。点某标签的会话数选一条即写入这里，
  // 取消勾选/选"用默认"则移除；点底部「恢复」时连同勾选一起传给 restoreSavedTabs。
  const overrides = new Map<string, string>()
  const items: PickItem[] = s.snapshot.tabs.map((st) => {
    const inLive = liveIds.has(st.id)
    const activeId = st.activeSessionId ?? st.sessions[st.sessions.length - 1]?.sessionId
    return {
      id: st.id,
      label: st.name,
      meta: inLive ? t('已在当前分组中') : t('{0} 个会话', st.sessions.length),
      disabled: inLive,
      // 默认不勾 —— 用户语义是"看一下要恢复哪些"，避免直接全恢复
      defaultChecked: false,
      deleteTitle: t('从保存里删除此标签'),
      onDelete: () => deleteSavedTabFromPicker(savedId, st.id, st.name),
      // 已在 live 里的标签不提供会话选择（会被跳过）
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
  // 末尾追加"新建空白标签"操作项：用户可能只想恢复分组同时顺手开一个空标签。
  // inputPlaceholder 让那行渲染成可输入框，用户可直接打字命名；不输入则用默认字母。
  // sideToggle 控制新标签是否自动启动 CC，默认取设置里的值。
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

// pick 弹窗里点单个标签的小垃圾桶 → 二次确认 → 从快照里抽掉。
// 删空也保留分组卡片（用户语义：只删标签，不动分组本身；要删整组走右键菜单）。
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
        // 没标签可选了，pick 弹窗也没意义了；分组卡片留着
        closePickTabs()
        toast(t('「{0}」已没有保存的标签', s.name))
        return
      }
      // 弹窗里就地刷新一遍 —— 复用 openRestoreSelect，不闪不丢焦点。
      openRestoreSelect(savedId)
    }
  })
}

// （原 main.ts 中未接线的入口，随移植保留并导出，防止后续组件需要）
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
      // 对应 live 分组没有保存记录时 isGroupDirty 天然为 true
      refreshUI()
      scheduleSave()
      toast(t('已删除保存的分组'))
    }
  })
}

// （原 main.ts 中未接线的入口，随移植保留并导出，防止后续组件需要）
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

// 在新标签页中恢复该会话：同组 makeTab，把这条 session 记录挪进去当栈顶，
// autoLaunchCC 触发 launchCC → 走 --resume 分支。原标签的栈记录保留不动，
// 由用户自己判断是否要在原处删除；两处同时激活同一 sessionId 可能造成
// jsonl 双写，属于已知边界，不主动拦。
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

// ─── 切换历史会话（栈下拉） ────────────────────────────────────────
export async function switchSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (!tab.sessions.some((s) => s.sessionId === sessionId)) return
  tab.activeSessionId = sessionId
  scheduleSave()
  // 重启 PTY + launchCC（onPtyStarted 会触发 launchCC，自动走 resume 分支）
  await tab.restartPty()
  refreshUI()
  busEmit('sessionInfo:nudge')
}

// ─── 右键菜单 ──────────────────────────────────────────────────────
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

// 把标签手动标成 done（绿点），不启动倒计时；下次"切回"该 tab 才走 maybeStartDowngrade。
// 已经在该 tab 上时不会自动切走，所以也不会起倒计时 —— 绿点一直留着直到你"再次进入"。
export function markTabPending(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  ctx.tab.status = 'done'
  ctx.tab.note = undefined
  // 若该 tab 上恰有一个倒计时正在跑（之前已 active），先取消；按用户语义"再次进入才计时"
  if (downgradeTabId === tabId) clearDowngradeTimer()
  refreshUI()
  scheduleSave()
}

// "标记为已查看"：手动清掉侧栏点（done/attention/error → idle），不用切走 tab 再等降级。
// busy 不清 —— 那是 cc 真在跑，跟"看过没"两回事；idle 本来就没点，直接短路。
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
  // 按当前状态语义化切换：
  //   idle → 允许"标记为待查看"（留自己看的标签）
  //   done/attention/error → 允许"标记为已查看"（清点降噪）
  //   busy → 都不给：cc 正在跑，改状态只会掩盖真实进度
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
      { label: t('在本组新建标签'), icon: icon('plus'), act: () => promptNewTabInGroup(ctx.group.id) },
      { sep: true },
      { label: t('关闭标签'), icon: icon('close'), danger: true, act: () => closeTab(tabId) }
    ],
    x,
    y
  )
}

// ─── 保存/恢复整个工作区（当前 groups+activeTabId 打包） ────────────
function nextWorkspaceDefaultName(): string {
  // 默认名 "工作区N"：找当前 savedWorkspaces 里最大数字 + 1
  let max = 0
  for (const w of savedWorkspaces) {
    // 兼容中英两种默认名形态：「工作区N」/「Workspace N」都参与取最大序号
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

// 把快照分组追加恢复到当前工作区（工作区整体恢复 / 单分组恢复共用）。
// 返回新建标签数。已打开的同分组不覆盖，只补齐缺失的标签。
async function restoreSnapshotGroups(
  sgs: SavedWorkspaceSnapshotGroup[],
  preferActiveTabId: string | null
): Promise<number> {
  // 1) 先把分组建好、收集待恢复的标签规格（此步很轻，不创建 xterm 实例）。
  //    把重活（new Terminal + mount + startPty）留到后面分批做，避免一次性堆成长任务。
  const pending: { group: Group; spec: Parameters<typeof makeTab>[1] }[] = []
  for (const sg of sgs) {
    // 用已存在的同 id/同名同 cwd 分组，否则新建（与 restoreSavedTabs 逻辑保持一致）
    let g = findGroup(sg.id)
      || groups.find((x) => x.name === sg.name && x.cwd === sg.cwd)
    if (!g) g = ensureGroup({ name: sg.name, cwd: sg.cwd })
    // 该分组若有单分组保存记录，把 srcId 重绑到本次的 live 分组 ——
    // isGroupDirty / autoSyncTabToSaved 都只按 srcId 找记录，不重绑的话
    // "明明已保存的分组"恢复出来就会因 srcId 对不上被标脏（黄点）。
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
          dirty: false
        }
      })
    }
  }
  // 分组结构先渲染出来，标签随后分批冒出（配合"全部收起"就只先看到分组维度）
  refreshUI()
  if (pending.length === 0) return 0

  // 2) 提前算好前台目标：快照里存的 active tab（若确实在待恢复集合里），否则第一个。
  //    严格按快照顺序创建标签，保证组内标签顺序不乱；等目标标签所在那一批建好即激活它，
  //    既让前台尽快可见、又不会"先激活错的再跳"闪烁。
  const targetActiveId =
    preferActiveTabId && pending.some((p) => p.spec.id === preferActiveTabId)
      ? preferActiveTabId
      : pending[0].spec.id

  // 3) 分批创建 + 拉起 PTY：每批只建 RESTORE_BATCH 个 xterm，批与批之间让出一帧，
  //    主线程始终有余量处理鼠标/绘制，不再因 N 个标签同步初始化整屏掉帧。
  let activated = false
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
      // 确认恢复即算"动过"（哪怕都已打开、n=0），把该工作区顶到侧边栏最前
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

// ─── 视图数据 getter（原 Sidebar hooks） ──────────────────────────
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

// 侧边栏渲染：按名称排序（中文拼音 + 数字自然），与管理弹窗保持一致
// 侧边栏快捷区：按「最近一次动过的时间」倒序（恢复优先，没恢复过就用保存时间）。
// 管理页仍走 naturalNameCompare，两处刻意不同。
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

// 分组拖拽排序（原 Sidebar hooks 里的内联实现）
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

// ─── 外部切模型/思考强度（B 方案） ────────────────────────────────
// 往当前活跃 tab 的 cc 注入斜杠命令。
// 前置校验：无活跃会话、或 cc 正忙（busy=正回复会排队，attention=有权限弹窗会误答）都拒绝。
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

// /model 带参 → 直接切、不弹选择器；cc 会把它存成新会话默认，故切一次即持久，无需改 launchCC。
// arg 为 alias（最新）或完整 model id（钉版本，退役会在终端报错）。
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

// ─── 全局键（Ctrl+S 兜底保存） ────────────────────────────────────
// Ctrl+S：把当前活动标签所在的脏分组保存到"已保存分组"。
// 终端聚焦时由 TerminalTab 的 attachCustomKeyEventHandler 调这里（并拦掉 XOFF）；
// 焦点在别处（侧边栏/弹窗）时走 window keydown 兜底（initApp 里注册）。
export function saveActiveDirtyGroup(): void {
  const g = groups.find((x) => x.tabs.some((t) => t.id === activeTabId))
  if (!g) return
  if (!isGroupDirty(g)) {
    toast(t('「{0}」没有未保存的改动', g.name))
    return
  }
  saveGroup(g.id)
}

// ─── SavedManager（管理弹窗）数据与回调 ───────────────────────────
function lastTsOf(t: SavedTab): string | undefined {
  let best: string | undefined
  for (const s of t.sessions) {
    const v = s.lastTs ?? s.createdAt
    if (!best || v > best) best = v
  }
  return best
}

// 管理弹窗渲染：按名称排序（与侧边栏一致）。底层 savedGroups 数组顺序不动 ——
// 排序在展示层做，已经不依赖手动拖动了。
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

// 以下四个是原 new SavedManager 时内联在 hooks 里的实现，提成具名函数
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

// SavedManager 组件的回调集合：键名与原 SavedManagerHooks 完全一致
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

// ─── 标签历史恢复 ────────────────────────────────────────────────
export async function restoreFromHistory(entry: HistoryEntry): Promise<void> {
  // 优先复用已存在的同 cwd 分组（用户语义上：标签回到原分组），找不到就新建一个
  let g = groups.find((x) => x.cwd === entry.cwd)
  if (!g) g = ensureGroup({ name: entry.groupName || entry.cwd, cwd: entry.cwd })
  // tabId 已在 live：直接激活即可，不重复打开
  if (g.tabs.some((t) => t.id === entry.tabId)) {
    activeTabId = entry.tabId
    activateUI(entry.tabId)
    toast(t('已切到「{0}」', entry.tabName))
    return
  }
  // 该分组已保存 且 该 tabId 在保存快照里就有：视为"回到已保存的位置"，不打脏。
  // 后续 spawn/会话事件走 autoSyncTabToSaved 把 saved snapshot 拉齐，保持"已保存"状态。
  // 关键：saved 匹配走 findSavedForGroup（按 srcId 或 name+cwd），因为恢复时 g 可能是
  // 通过 ensureGroup 新建的 —— 新 id 跟老 saved.srcId 对不上，必须用 name+cwd 兜底命中。
  // 命中后把 srcId 重绑到当前 live group，isGroupDirty / autoSync 后续才能找到它。
  const saved = findSavedForGroup(g)
  if (saved) saved.srcId = g.id
  const knownInSaved = !!saved?.snapshot.tabs.some((t) => t.id === entry.tabId)
  const tab = makeTab(g, {
    id: entry.tabId,
    name: entry.tabName,
    sessions: entry.sessions,
    activeSessionId: entry.activeSessionId,
    autoLaunchCC: entry.autoLaunchCC,
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

// ─── 启动 ────────────────────────────────────────────────────────
// preBoot：React 挂载前跑（main.tsx 里 await），settings/语言/平台类要在首帧渲染前就绪。
export async function preBoot(): Promise<void> {
  settings = await window.term.loadSettings()
  // 语言尽早定死：后续所有动态渲染（组件/弹窗）里的 t() 都依赖它。
  setLanguage(settings.language)
  // 平台标记：macOS 用系统红绿灯（frame hiddenInset），CSS 据 body.platform-mac
  // 隐藏自绘的右侧窗口按钮并给标题栏左侧留出红绿灯位置。
  document.body.classList.add(window.term.platform === 'darwin' ? 'platform-mac' : 'platform-win')
}

// initApp：组件树挂载后跑一次。等 hosts 容器就绪 → 注册全局事件/IPC 路由 → 加载 workspace。
// 轻量模式：只读 savedGroups/savedWorkspaces，groups/activeTabId 一律不恢复。
// 启动即空状态，等用户点「新建分组」或从已保存的分组恢复。
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
  // resume 会让旧 sessionId 再次发 SessionStart，按 sessionId 全栈去重，
  // 命中已有条目时只切激活，不重复 push。
  const offSession = window.term.onSessionEvent((ev) => {
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
      // resume 旧会话 → 把它挪到数组末尾（toolbar 倒序展示时即栈顶），
      // 反映"最近活跃"次序；之前只切 activeSessionId 不重排，导致栈顶永远是最后新建的那条。
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
    // 会话栈变了立刻落历史：force=true 确保即便刚刚才落过也再写一次新的 sessions
    recordTabHistory(tab, ctx.group.name, true)
  })

  // ─── 状态徽标事件 ───────────────────────────────────────────────
  const offState = window.term.onStateEvent((ev) => {
    const ctx = findTab(ev.tabId)
    if (!ctx) return
    // 外部 hook 不允许把 done/attention 降级回 idle —— 这两个态承载"有事/已完成未查看"的信号，
    // 降级是渲染层倒计时（用户切到该 tab 看过后才降）的独占权。
    // 历史上 idle_prompt → idle 的 hook 就在这里翻车：cc Stop 60s 没人理会发 idle_prompt，
    // 把绿点静默盖成灰点。hook 那条已删，这里再补一道闸防回归。
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

  // ─── 全局键 ─────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // ESC 关闭可能打开的搜索浮层
      closeSearchOverlay()
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      // 输入框 / 行内改名里不抢 Ctrl+S（虽然它们也用不上，但别打断输入心流）
      const t = e.target as HTMLElement
      if (!(t instanceof HTMLInputElement) && !t.closest?.('[contenteditable="true"]')) {
        e.preventDefault()
        saveActiveDirtyGroup()
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

  // ─── 关闭 app 时确认（兜底：任何情况都弹一次） ───────────────────
  // 有脏分组时展示分组明细；其他情况仍弹一个通用确认，防止误关。
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
      title: t('确认关闭 Claude Terminal？'),
      message: t('关闭后所有终端会话将被终止。确认继续？'),
      okLabel: t('关闭'),
      onOk: () => window.term.winConfirmClose()
    })
  })

  // ─── 启动恢复 ───────────────────────────────────────────────────
  const ws = await window.term.loadWorkspace()
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
          savedAt: s.savedAt
        }))
      }
    })
  }
  // 历史数据可能有同名同路径的重复条目（之前没合并），启动时统一收拢
  dedupSavedByNameCwd()
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
            savedAt: w.savedAt
          }))
        }))
      }
    })
  }
  refreshUI()
  // 启动时按当前设置同步悬浮窗（主进程也会按自己读到的设置拉起；这里再保一道，
  // 万一用户在 setting 文件里手改了也能立即生效）
  window.term.floaterSetEnabled(settings.showFloater)
  if (settings.showFloater) pushFloaterCounts()
  // 悬浮窗里通过右键菜单"隐藏"时，主进程已经销毁窗口并落盘 showFloater=false，
  // 这里同步刷新内存里的 settings 副本，避免设置面板还显示开。
  window.term.onFloaterHidden(() => {
    if (!settings.showFloater) return
    settings = { ...settings, showFloater: false }
  })
  // 右键菜单唤起：主进程解析 argv 后推 path 过来（second-instance 场景）。
  // 放在这里注册是等 settings/savedGroups 都加载好，openHereWithPath 才能正确读默认值。
  window.term.onOpenHere((p) => {
    void openHereWithPath(p)
  })
  // 首次启动 argv 带 --open-here：主动拉一次待消费队列。之前用 send 从主进程推
  // 会在 onOpenHere 监听器注册前送达（IPC 消息被丢弃），改用 invoke 主动拉不会漏。
  try {
    const pending = await window.term.consumePendingOpenHere()
    for (const p of pending) void openHereWithPath(p)
  } catch {}
}
