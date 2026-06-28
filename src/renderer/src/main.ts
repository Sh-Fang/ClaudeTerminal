import '@xterm/xterm/css/xterm.css'
import { TerminalTab, type SessionRecord } from './terminal-tab'
import { Sidebar, type GroupView, type SavedView } from './sidebar'
import { Toolbar } from './toolbar'
import { SettingsPanel } from './settings-panel'
import { DEFAULT_SETTINGS, type Settings } from './themes'
import {
  confirmDialog,
  escapeHtml,
  formatTs,
  isConfirmOpen,
  openModal,
  openPickTabs,
  shortPath,
  showCtxMenu,
  toast,
  type PickItem
} from './ui-helpers'
import { icon } from './svg-icons'
import { SavedManager, type ManageGroupView } from './saved-manager'
import { UsageIndicator } from './usage-indicator'
import { SessionInfoBar } from './session-info'
import { HistoryManager, type HistoryEntry } from './history-manager'

const usageIndicator = new UsageIndicator()

const SEARCH_DECOR = {
  matchBackground: '#3a3a00',
  matchBorder: '#e5e510',
  matchOverviewRuler: '#e5e510',
  activeMatchBackground: '#5a4a00',
  activeMatchBorder: '#f5f543',
  activeMatchColorOverviewRuler: '#f5f543'
}

const hostsEl = document.getElementById('hosts') as HTMLDivElement
const appEl = document.querySelector('.app') as HTMLDivElement
const sidebarEl = document.getElementById('sidebar') as HTMLElement
const sidebarResizer = document.getElementById('sidebarResizer') as HTMLDivElement
const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn') as HTMLButtonElement
const sidebarHandleEl = document.getElementById('sidebarHandle') as HTMLDivElement
const savedSectionEl = document.getElementById('savedSection') as HTMLElement
const savedToggleBtn = document.getElementById('savedToggle') as HTMLButtonElement
const historyOpenBtn = document.getElementById('historyOpenBtn') as HTMLButtonElement

// ─── 状态 ───────────────────────────────────────────────────────────
interface Group {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

// 分组是否"脏"：组内有未保存标签，或组元信息（name/cwd）与已保存的不一致，
// 或根本没有对应的已保存条目。
function isGroupDirty(g: Group): boolean {
  if (g.tabs.some((t) => t.dirty)) return true
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
  snapshot: {
    name: string
    cwd: string
    tabs: SavedTab[]
  }
  srcId?: string
}

const groups: Group[] = []
const savedGroups: SavedGroup[] = []
let activeTabId: string | null = null
let saveDebounceTimer: number | null = null
let settings: Settings = DEFAULT_SETTINGS
let settingsSaveTimer: number | null = null

function getSettings(): Settings { return settings }

function applySettingsToAll(): void {
  for (const g of groups) for (const t of g.tabs) t.applySettings(settings)
}

function updateSettings(s: Settings): void {
  settings = s
  applySettingsToAll()
  usageIndicator.applySettings(settings.showClaudeUsage)
  // 设置里可能改了「已保存分组显示数量」，重渲染让侧边栏与管理弹窗即时反映
  sidebar.render()
  savedManager.render()
  if (settingsSaveTimer != null) window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null
    void window.term.saveSettings(settings).then((normed) => {
      // 主进程归一化后回写，可能 clamp 了字段；保持本地一致
      settings = normed
    })
  }, 300)
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function quotePs(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cachedHookSettingsArg: string | null = null
async function hookSettingsArg(): Promise<string> {
  if (cachedHookSettingsArg) return cachedHookSettingsArg
  const hp = await window.term.hookPaths()
  cachedHookSettingsArg = ` --settings ${quotePs(hp.ccHooksJson)}`
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
function activeContext(): { group: Group; tab: TerminalTab } | null {
  return activeTabId ? findTab(activeTabId) : null
}
function findGroup(groupId: string): Group | undefined {
  return groups.find((g) => g.id === groupId)
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
      tab.term.writeln(`\x1b[33m[claude 路径不存在：${claudeBin}，跳过自动启动]\x1b[0m`)
      tab.term.writeln('\x1b[90m请到设置 → Claude Code 中重新选择 claude 可执行文件。\x1b[0m')
      return
    }
  } else {
    const available = await window.term.claudeAvailable()
    if (!available) {
      tab.term.writeln('\x1b[90m[claude 未在 PATH 中，跳过自动启动 Claude Code]\x1b[0m')
      return
    }
  }
  // 自定义路径走 PS 引号；默认走裸 claude（让 PS 自己解析）
  const claudeCmd = claudeBin ? quotePs(claudeBin) : 'claude'
  // 用户填的是 .ps1/.cmd/.exe 都得加 & 调用操作符，否则 PS 不会执行带空格/反斜杠的绝对路径
  const invoker = claudeBin ? '& ' : ''

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
    cmd = `${invoker}${claudeCmd} --session-id ${newId} --name ${quotePs(tab.name)}${settingsArg}`
  }
  window.term.send(tab.ptyId, cmd + '\r')
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
      openSearch,
      onRequestNewTab: () => promptNewTabInGroup(group.id),
      onRequestCloseSelf: () => closeTab(id),
      onPtyStarted: () => void launchCC(tabRef),
      onUserAbort: () => {
        if (tabRef.status !== 'busy') return
        tabRef.status = 'idle'
        tabRef.note = undefined
        sidebar.render()
        toolbar.render()
      }
    }
  )
  group.tabs.push(tabRef)
  tabRef.mount(hostsEl)
  // 新建/恢复出来的 tab 立刻落历史，崩溃前哪怕一秒没动也能找回
  recordTabHistory(tabRef, group.name, true)
  return tabRef
}

async function spawnTabPty(tab: TerminalTab): Promise<void> {
  await tab.startPty()
  // 异步刷新 aiTitle / lastTs（首次出现就重渲染）
  void refreshSessionMeta(tab)
}

async function refreshSessionMeta(tab: TerminalTab): Promise<void> {
  let changed = false
  for (const s of tab.sessions) {
    const meta = await window.term.claudeSessionMeta(s.sessionId)
    if (!meta.exists) continue
    if (meta.aiTitle && meta.aiTitle !== s.aiTitle) {
      s.aiTitle = meta.aiTitle
      changed = true
    }
    if (meta.lastTs && meta.lastTs !== s.lastTs) {
      s.lastTs = meta.lastTs
      changed = true
    }
  }
  if (changed) {
    scheduleSave()
    sidebar.render()
    toolbar.render()
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

async function newGroup(): Promise<void> {
  const prefilledCwd = settings.lastUsedCwd || settings.defaults.cwd
  openModal({
    kind: 'new-group',
    title: '新建分组',
    sub: '分组以路径为单位。组内可挂多个标签。',
    name: '新分组',
    cwd: prefilledCwd,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    showTabName: true,
    tabName: 'A',
    okLabel: '创建',
    onPickCwd: (cur) => window.term.pickDirectory(cur || prefilledCwd),
    onOk: async (v) => {
      const cwd = v.cwd?.trim() || ''
      const g = ensureGroup({ name: v.name, cwd })
      sidebar.render()
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
      toast(`已新建分组「${g.name}」`)
    }
  })
}

async function promptNewTabInGroup(groupId: string): Promise<void> {
  const g = findGroup(groupId)
  if (!g) return
  const nm = String.fromCharCode(65 + g.tabs.length)
  openModal({
    kind: 'new-tab',
    title: `在「${g.name}」新建标签`,
    sub: '同分组共用 cwd。',
    name: nm,
    cwd: undefined,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    okLabel: '创建',
    onOk: async (v) => {
      const tab = makeTab(g, { name: v.name, autoLaunchCC: v.autoLaunchCC })
      g.collapsed = false
      activeTabId = tab.id
      sidebar.render()
      activateUI(tab.id)
      await spawnTabPty(tab)
      scheduleSave()
    }
  })
}

function activateUI(tabId: string): void {
  for (const g of groups) for (const t of g.tabs) t.setActive(t.id === tabId)
  sidebar.render()
  toolbar.render()
}

// 查看降级：用户切到 done/attention 的标签后，停留 settings.statusDowngradeSec 秒才把状态降回 idle。
// 用意：误点切走时绿点仍保留；真正"我看过了"才消失。
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
  if (st !== 'done' && st !== 'attention') return
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
    sidebar.render()
    toolbar.render()
    scheduleSave()
  }, settings.statusDowngradeSec * 1000)
}

function activateTab(tabId: string): void {
  if (activeTabId === tabId) return
  const ctx = findTab(tabId)
  if (!ctx) return
  activeTabId = tabId
  // 切走旧 tab → 取消其降级倒计时（保留绿点，下次再切回来重新计时）
  clearDowngradeTimer()
  maybeStartDowngrade(tabId, ctx.tab.status)
  activateUI(tabId)
  sessionInfo.nudge()
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

function closeTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { group, tab } = ctx
  const isLast = group.tabs.length === 1
  confirmDialog({
    title: `关闭标签「${tab.name}」？`,
    message: `该标签下有 <b>${tab.sessions.length}</b> 条会话，关闭后该标签将从分组移除。` +
      (isLast ? '<br/>这是分组「' + escapeHtml(group.name) + '」的最后一个标签，关闭后<b>分组也会被关闭</b>。' : ''),
    okLabel: '关闭标签',
    onOk: () => {
      disposeTabInternal(group, tab)
      // 空分组自动收尾
      if (group.tabs.length === 0) {
        const idx = groups.indexOf(group)
        if (idx >= 0) groups.splice(idx, 1)
      }
      sidebar.render()
      toolbar.render()
      scheduleSave()
    }
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

function renameTab(tabId: string, newName: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  if (!newName.trim()) return
  ctx.tab.name = newName.trim()
  ctx.tab.dirty = true
  sidebar.render()
  toolbar.render()
  scheduleSave()
}

function toggleGroupCollapse(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  g.collapsed = !g.collapsed
  sidebar.render()
  scheduleSave()
}

function renameGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  openModal({
    kind: 'rename',
    title: '重命名分组',
    sub: '只改名字，cwd 与标签保持不变。',
    name: g.name,
    okLabel: '保存',
    onOk: (v) => {
      g.name = v.name
      // 分组元信息变了 → isGroupDirty 会通过 name 与 saved.snapshot.name 不一致自然为 true
      sidebar.render()
      toolbar.render()
      scheduleSave()
      toast('已重命名分组')
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

function saveGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const savedAt = new Date().toISOString()
  const existing = savedGroups.find((s) => s.srcId === g.id)
  if (existing) {
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
  for (const t of g.tabs) t.dirty = false
  sidebar.render()
  savedManager.render()
  scheduleSave()
  toast(`已保存「${g.name}」（${g.tabs.length} 个标签）`)
}

function saveTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { group: g, tab } = ctx
  const savedAt = new Date().toISOString()
  let saved = savedGroups.find((s) => s.srcId === g.id)
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
  }
  saved.snapshot.tabs = mergeTabsIntoSnapshot(saved.snapshot.tabs, [tab], savedAt)
  saved.savedAt = savedAt
  // 同步 saved 的 group 元信息（如果与 live 不一致）
  saved.name = g.name
  saved.cwd = g.cwd
  saved.snapshot.name = g.name
  saved.snapshot.cwd = g.cwd
  tab.dirty = false
  sidebar.render()
  savedManager.render()
  scheduleSave()
  toast(`已保存标签「${tab.name}」`)
}

function closeGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const saved = savedGroups.some((s) => s.srcId === g.id) && !isGroupDirty(g)
  const busyCount = g.tabs.filter((t) => t.status === 'busy' || t.status === 'attention').length
  const busyHint = busyCount > 0
    ? `<br/><b>注意</b>：其中 <b>${busyCount}</b> 个标签正在运行或待决策，关闭会立即中断。`
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
    sidebar.render()
    toolbar.render()
    scheduleSave()
    toast(`已关闭分组「${g.name}」`)
  }
  // 未保存分组 + 用户关掉了二次确认 + 无 busy 标签 → 直接关闭不打扰。
  // 已保存分组（可恢复）保持原确认；有 busy 标签则强制确认，避免误中断运行中的任务。
  if (!saved && !settings.confirmCloseUnsaved && busyCount === 0) {
    doClose()
    return
  }
  confirmDialog({
    title: `关闭分组「${g.name}」？`,
    message: `将关闭该分组下的 ${g.tabs.length} 个标签。` +
      (saved
        ? '该分组<b>已保存</b>，之后可在「已保存的分组」一键恢复。'
        : '该分组<b>尚未保存</b>（或有改动未保存），关闭后将无法恢复其标签布局。') +
      busyHint,
    okLabel: '关闭分组',
    onOk: doClose
  })
}

// "勾选恢复" 弹窗里追加的特殊操作项：恢复结束顺手新开一个空白标签。
const PICK_ACTION_NEW_BLANK = '__new_blank__'

// 真正的恢复：按 tabIds 把保存里的标签实例化进 live 分组。
// 已经在 live 分组里（按 id 命中）的标签会被跳过。
// 若 ids 里含 PICK_ACTION_NEW_BLANK，恢复完再 makeTab 一个新空标签，并立刻
// autoSync 到 saved snapshot —— 用户希望"在恢复弹窗里勾的新标签，默认就是已保存"。
async function restoreSavedTabs(
  savedId: string,
  tabIds: string[],
  blankName?: string
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
      activeSessionId: t.activeSessionId,
      autoLaunchCC: t.autoLaunchCC,
      dirty: false
    })
    created.push(tab)
  }
  // 新建空白标签：优先用用户输入名，没输入就用字母自动起（与 promptNewTabInGroup 一致）
  let blank: TerminalTab | null = null
  if (addBlank) {
    const nm = blankName?.trim() || String.fromCharCode(65 + g.tabs.length)
    blank = makeTab(g, {
      name: nm,
      autoLaunchCC: settings.defaults.autoLaunchCC,
      dirty: false
    })
    created.push(blank)
    // 立刻写入 saved snapshot，保持分组"已保存"状态（用户期望：在恢复里新建的默认就保存）
    autoSyncTabToSaved(blank, g)
  }
  if (!activeTabId) {
    const first = created[0] ?? g.tabs[0]
    if (first) activeTabId = first.id
  }
  sidebar.render()
  toolbar.render()
  savedManager.render()
  if (activeTabId) activateUI(activeTabId)
  for (const t of created) await spawnTabPty(t)
  scheduleSave()
  // toast 文案区分：纯新建 / 恢复+新建 / 纯恢复
  const restoredN = created.length - (addBlank ? 1 : 0)
  if (created.length === 0) toast(`分组「${s.name}」已经打开`)
  else if (restoredN === 0 && addBlank) toast(`在「${s.name}」新建了 1 个空白标签`)
  else if (addBlank) toast(`已恢复「${s.name}」${restoredN} 个标签 + 1 个新空白`)
  else toast(`已恢复「${s.name}」的 ${restoredN} 个标签`)
}

function restoreSavedAll(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  void restoreSavedTabs(savedId, s.snapshot.tabs.map((t) => t.id))
}

// 卡片点击 → 弹"选择恢复"对话框（外面的"恢复"默认走这里）
function openRestoreSelect(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  if (s.snapshot.tabs.length === 0) {
    toast('该保存的分组里没有标签')
    return
  }
  const live = s.srcId ? findGroup(s.srcId) : undefined
  const liveIds = new Set(live?.tabs.map((t) => t.id) ?? [])
  const items: PickItem[] = s.snapshot.tabs.map((t) => {
    const inLive = liveIds.has(t.id)
    return {
      id: t.id,
      label: t.name,
      meta: inLive ? '已在当前分组中' : `${t.sessions.length} 个会话`,
      disabled: inLive,
      defaultChecked: !inLive
    }
  })
  // 末尾追加"新建空白标签"操作项：用户可能只想恢复分组同时顺手开一个空标签。
  // inputPlaceholder 让那行渲染成可输入框，用户可直接打字命名；不输入则用默认字母。
  items.push({
    id: PICK_ACTION_NEW_BLANK,
    label: '',
    meta: '默认即已保存',
    defaultChecked: false,
    inputPlaceholder: '+ 新建空白标签（直接输入名字）'
  })
  openPickTabs({
    title: `恢复「${s.name}」的标签`,
    sub: '勾选要恢复的标签。已在当前分组中的标签会被跳过。',
    items,
    okLabel: '恢复',
    onOk: (ids, inputs) => void restoreSavedTabs(savedId, ids, inputs[PICK_ACTION_NEW_BLANK])
  })
}

function deleteSaved(savedId: string): void {
  const idx = savedGroups.findIndex((s) => s.id === savedId)
  if (idx < 0) return
  const s = savedGroups[idx]
  confirmDialog({
    title: `删除已保存的「${s.name}」？`,
    message: '只删除保存记录，不影响当前打开的分组。',
    okLabel: '删除',
    onOk: () => {
      savedGroups.splice(idx, 1)
      // 对应 live 分组没有保存记录时 isGroupDirty 天然为 true
      sidebar.render()
      savedManager.render()
      scheduleSave()
      toast('已删除保存的分组')
    }
  })
}

function renameSaved(savedId: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  openModal({
    kind: 'rename',
    title: '重命名已保存的分组',
    sub: '只改保存项的名字。',
    name: s.name,
    okLabel: '保存',
    onOk: (v) => {
      s.name = v.name
      s.snapshot.name = v.name
      sidebar.render()
      savedManager.render()
      scheduleSave()
    }
  })
}

// ─── 栈内会话右键菜单（重命名 / 删除；改完默认同步到 saved） ──────
function openSessionCtx(sessionId: string, x: number, y: number): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const onlyOne = ctx.tab.sessions.length <= 1
  const items: import('./ui-helpers').CtxItem[] = [
    { label: '重命名会话', icon: icon('edit'), act: () => renameSession(sessionId) }
  ]
  if (sess.userTitle) {
    items.push({ label: '清除自定义标题', icon: icon('rotate-ccw'), act: () => renameSession(sessionId, '') })
  }
  items.push({ sep: true })
  if (onlyOne) {
    items.push({ label: '删除（至少保留一条）', icon: icon('trash'), act: () => toast('至少保留一条会话') })
  } else {
    items.push({ label: '删除会话', icon: icon('trash'), danger: true, act: () => void deleteSession(sessionId) })
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
    sidebar.render()
    toolbar.render()
    scheduleSave()
  }
  // 显式清除分支：右键「清除自定义标题」时跳过 modal
  if (forceText === '') {
    apply('')
    toast('已清除自定义标题')
    return
  }
  const current = sess.userTitle ?? sess.aiTitle ?? ''
  openModal({
    kind: 'rename',
    title: '重命名会话',
    sub: 'Claude 生成的 aiTitle 可能滞后或没有，可以手动起个名。右键菜单可「清除自定义标题」回退到 aiTitle。',
    name: current,
    okLabel: '保存',
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
  const title = sess.aiTitle || `（${sess.sessionId.slice(0, 8)}）`
  confirmDialog({
    title: `删除会话「${title}」？`,
    message: wasActive
      ? '这是当前激活的会话，删除后会切到栈顶并重启 shell。<br/>已在磁盘的 cc 历史不会被删，只是从此标签的栈里移除。'
      : '只把该会话从栈里移除。磁盘上的 cc 历史不受影响。',
    okLabel: '删除',
    onOk: () => {
      tab.sessions.splice(idx, 1)
      if (wasActive) {
        const top = tab.sessions[tab.sessions.length - 1]
        tab.activeSessionId = top?.sessionId
        void tab.restartPty()
      }
      autoSyncTabToSaved(tab, group)
      sidebar.render()
      toolbar.render()
      scheduleSave()
      toast('已删除会话')
    }
  })
}

// ─── 切换历史会话（栈下拉） ────────────────────────────────────────
async function switchSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (!tab.sessions.some((s) => s.sessionId === sessionId)) return
  tab.activeSessionId = sessionId
  scheduleSave()
  // 重启 PTY + launchCC（onPtyStarted 会触发 launchCC，自动走 resume 分支）
  await tab.restartPty()
  toolbar.render()
  sidebar.render()
  sessionInfo.nudge()
}

// ─── 右键菜单 ──────────────────────────────────────────────────────
function openGroupCtx(groupId: string, x: number, y: number): void {
  const g = findGroup(groupId)
  if (!g) return
  showCtxMenu(
    [
      { label: '新建会话标签', icon: icon('plus'), act: () => promptNewTabInGroup(g.id) },
      { label: '重命名分组', icon: icon('edit'), act: () => renameGroup(g.id) },
      { sep: true },
      { label: '保存分组', icon: icon('save'), act: () => saveGroup(g.id) },
      { sep: true },
      { label: '关闭分组', icon: icon('close'), danger: true, act: () => closeGroup(g.id) }
    ],
    x,
    y
  )
}

function openTabCtx(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  showCtxMenu(
    [
      {
        label: '重命名标签',
        icon: icon('edit'),
        act: () => {
          openModal({
            kind: 'rename',
            title: '重命名标签',
            sub: '',
            name: ctx.tab.name,
            okLabel: '保存',
            onOk: (v) => renameTab(tabId, v.name)
          })
        }
      },
      { label: '在本组新建标签', icon: icon('plus'), act: () => promptNewTabInGroup(ctx.group.id) },
      { sep: true },
      { label: '保存标签', icon: icon('save'), act: () => saveTab(tabId) },
      { sep: true },
      { label: '关闭标签', icon: icon('close'), danger: true, act: () => closeTab(tabId) }
    ],
    x,
    y
  )
}

function openSavedCtx(savedId: string, x: number, y: number): void {
  showCtxMenu(
    [
      { label: '选择恢复', icon: icon('rotate-ccw'), act: () => openRestoreSelect(savedId) },
      { label: '一键恢复分组', icon: icon('rotate-ccw'), act: () => restoreSavedAll(savedId) },
      { label: '重命名', icon: icon('edit'), act: () => renameSaved(savedId) },
      { sep: true },
      { label: '删除保存', icon: icon('trash'), danger: true, act: () => deleteSaved(savedId) }
    ],
    x,
    y
  )
}

// ─── 实例化 sidebar / toolbar ─────────────────────────────────────
const sidebar = new Sidebar({
  getGroups: (): GroupView[] =>
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      cwd: g.cwd,
      collapsed: g.collapsed,
      tabs: g.tabs,
      dirty: isGroupDirty(g)
    })),
  getSaved: (): SavedView[] =>
    savedGroups.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: shortPath(s.cwd),
      tabCount: s.snapshot.tabs.length,
      savedAt: formatTs(s.savedAt)
    })),
  getSavedLimit: () => settings.savedSidebarLimit,
  getActiveTabId: () => activeTabId,
  activateTab,
  closeTab,
  renameTab,
  toggleGroupCollapse,
  onGroupCtx: openGroupCtx,
  onTabCtx: openTabCtx,
  onSavedCtx: openSavedCtx,
  addTabInGroup: promptNewTabInGroup,
  newGroup: () => void newGroup(),
  reorderGroups: (ids) => {
    const map = new Map(groups.map((g) => [g.id, g]))
    const next: Group[] = []
    for (const id of ids) {
      const g = map.get(id)
      if (g) next.push(g)
    }
    for (const g of groups) if (!ids.includes(g.id)) next.push(g)
    groups.splice(0, groups.length, ...next)
    sidebar.render()
  },
  restoreSaved: openRestoreSelect,
  openManageSaved: () => savedManager.open()
})

const toolbar = new Toolbar({
  getActiveTab: () => {
    const ctx = activeContext()
    if (!ctx) return null
    return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
  },
  switchSession: (id) => void switchSession(id),
  onSessionCtx: openSessionCtx
})

const sessionInfo = new SessionInfoBar({
  getActive: () => {
    const ctx = activeContext()
    if (!ctx) return null
    return { sessionId: ctx.tab.activeSessionId ?? null, cwd: ctx.group.cwd }
  }
})

// ─── Search popover ────────────────────────────────────────────────
const searchUI = document.getElementById('search') as HTMLDivElement
const searchInput = document.getElementById('search-input') as HTMLInputElement
const searchCount = document.getElementById('search-count') as HTMLSpanElement
const searchClose = document.getElementById('search-close') as HTMLButtonElement
let searchBound: TerminalTab | null = null
let lastQuery = ''
const searchSubs = new WeakSet<TerminalTab>()

function rebindSearch(tab: TerminalTab): void {
  searchBound = tab
  if (searchSubs.has(tab)) return
  searchSubs.add(tab)
  tab.search.onDidChangeResults?.((e) => {
    if (searchBound !== tab) return
    if (!e || e.resultCount === 0) {
      searchCount.textContent = lastQuery ? '0' : ''
      return
    }
    searchCount.textContent = `${e.resultIndex + 1}/${e.resultCount}`
  })
}
function runSearch(direction: 'next' | 'prev'): void {
  const ctx = activeContext()
  if (!ctx) return
  rebindSearch(ctx.tab)
  const q = searchInput.value
  lastQuery = q
  if (!q) {
    ctx.tab.term.clearSelection()
    searchCount.textContent = ''
    return
  }
  const opts = { decorations: SEARCH_DECOR }
  if (direction === 'next') ctx.tab.search.findNext(q, opts)
  else ctx.tab.search.findPrevious(q, opts)
}
function openSearch(): void {
  const ctx = activeContext()
  if (!ctx) return
  rebindSearch(ctx.tab)
  searchUI.classList.add('open')
  searchInput.focus()
  searchInput.select()
}
function closeSearch(): void {
  searchUI.classList.remove('open')
  const ctx = activeContext()
  ctx?.tab.search.clearDecorations()
  ctx?.tab.term.clearSelection()
  ctx?.tab.term.focus()
}
searchInput.addEventListener('input', () => runSearch('next'))
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    runSearch(e.shiftKey ? 'prev' : 'next')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
})
searchClose.addEventListener('click', () => closeSearch())

// ─── Window controls ─────────────────────────────────────────────
const winClose = document.getElementById('win-close') as HTMLButtonElement | null
const winMin = document.getElementById('win-min') as HTMLButtonElement | null
const winMax = document.getElementById('win-max') as HTMLButtonElement | null
winClose?.addEventListener('click', () => window.term.winClose())
winMin?.addEventListener('click', () => window.term.winMinimize())
winMax?.addEventListener('click', () => window.term.winToggleMaximize())
// 双击 titlebar 切最大化（macOS 同款行为）
document.querySelector('.titlebar')?.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('.win-ctrls')) return
  window.term.winToggleMaximize()
})

// ─── PTY 全局路由 ─────────────────────────────────────────────────
const offData = window.term.onData((id, data) => {
  for (const g of groups) for (const t of g.tabs) if (t.ptyId === id) return t.writeFromPty(data)
})
const offExit = window.term.onExit((id, exitCode) => {
  for (const g of groups) for (const t of g.tabs) if (t.ptyId === id) return t.handlePtyExit(exitCode)
})

// ─── 会话事件压栈 ────────────────────────────────────────────────
// resume 会让旧 sessionId 再次发 SessionStart，按 sessionId 全栈去重，
// 命中已有条目时只切激活，不重复 push。
const offSession = window.term.onSessionEvent((ev) => {
  const ctx = findTab(ev.tabId)
  if (!ctx) return
  const { tab } = ctx
  // 清掉历史累积的同 id 重复条目（早期版本无去重）
  if (tab.sessions.length > 1) {
    const seen = new Set<string>()
    tab.sessions = tab.sessions.filter((s) => {
      if (seen.has(s.sessionId)) return false
      seen.add(s.sessionId)
      return true
    })
  }
  const existed = tab.sessions.find((s) => s.sessionId === ev.sessionId)
  if (existed) {
    if (ev.ts && (!existed.lastTs || ev.ts > existed.lastTs)) existed.lastTs = ev.ts
    if (tab.activeSessionId !== ev.sessionId) {
      tab.activeSessionId = ev.sessionId
      scheduleSave()
      sidebar.render()
      toolbar.render()
    }
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
  sidebar.render()
  toolbar.render()
  void refreshSessionMeta(tab)
  // 会话栈变了立刻落历史：force=true 确保即便刚刚才落过也再写一次新的 sessions
  recordTabHistory(tab, ctx.group.name, true)
})

// ─── 状态徽标事件 ────────────────────────────────────────────────
const offState = window.term.onStateEvent((ev) => {
  const ctx = findTab(ev.tabId)
  if (!ctx) return
  ctx.tab.status = ev.state
  ctx.tab.note = ev.message
  // 状态变了 → 重置该 tab 之前未触发的降级；若仍是当前 tab 且新态需降级，重启倒计时
  if (ev.tabId === downgradeTabId) clearDowngradeTimer()
  if (activeTabId === ev.tabId) maybeStartDowngrade(ev.tabId, ev.state)
  scheduleSave()
  sidebar.render()
  toolbar.render()
})

// ─── 全局键 ───────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // ESC 关闭可能打开的浮层
    searchUI.classList.remove('open')
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

// ─── Resize ───────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  activeContext()?.tab.refit()
})
ro.observe(hostsEl)

window.addEventListener('beforeunload', () => {
  offData()
  offExit()
  offSession()
  offState()
  sessionInfo.dispose()
  for (const g of groups) for (const t of g.tabs) t.dispose()
})

// ─── 关闭 app 时检查未保存分组 ────────────────────────────────────
window.term.onWindowCloseRequest(() => {
  if (isConfirmOpen()) return // 已有确认弹窗在显示，忽略重复触发
  const dirtyGroups = groups.filter((g) => isGroupDirty(g) && g.tabs.length > 0)
  if (dirtyGroups.length === 0 || !settings.confirmCloseUnsaved) {
    window.term.winConfirmClose()
    return
  }
  const lines = dirtyGroups
    .map((g) => `• <b>${escapeHtml(g.name)}</b>（${g.tabs.length} 个标签）`)
    .join('<br/>')
  confirmDialog({
    title: '有未保存的分组，仍要关闭？',
    message: `以下分组未保存，关闭后将丢失标签布局：<br/>${lines}<br/><br/>` +
      '可先在分组右键「保存分组」，或直接关闭。',
    okLabel: '仍然关闭',
    onOk: () => window.term.winConfirmClose()
  })
})

// ─── Sidebar 宽度 / 收起 / 悬浮预览 ──────────────────────────────
function applySidebarLayout(): void {
  document.documentElement.style.setProperty('--sidebar-w', `${settings.sidebarWidth}px`)
  appEl.classList.toggle('sidebar-collapsed', settings.sidebarCollapsed)
  sidebarEl.classList.toggle('collapsed', settings.sidebarCollapsed)
  sidebarHandleEl.hidden = !settings.sidebarCollapsed
  savedSectionEl.classList.toggle('collapsed', settings.savedCollapsed)
}

function persistSettings(): void {
  if (settingsSaveTimer != null) window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null
    void window.term.saveSettings(settings).then((normed) => { settings = normed })
  }, 300)
}

sidebarResizer.addEventListener('mousedown', (e) => {
  if (settings.sidebarCollapsed) return
  e.preventDefault()
  document.body.classList.add('col-resizing')
  sidebarResizer.classList.add('dragging')
  const startX = e.clientX
  const startW = settings.sidebarWidth
  const onMove = (ev: MouseEvent): void => {
    const w = Math.max(180, Math.min(520, startW + (ev.clientX - startX)))
    settings = { ...settings, sidebarWidth: w }
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
  }
  const onUp = (): void => {
    document.body.classList.remove('col-resizing')
    sidebarResizer.classList.remove('dragging')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    persistSettings()
    activeContext()?.tab.refit()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})

sidebarCollapseBtn.addEventListener('click', () => {
  settings = { ...settings, sidebarCollapsed: true }
  applySidebarLayout()
  persistSettings()
  setTimeout(() => activeContext()?.tab.refit(), 180)
})

sidebarHandleEl.addEventListener('click', () => {
  settings = { ...settings, sidebarCollapsed: false }
  applySidebarLayout()
  persistSettings()
  setTimeout(() => activeContext()?.tab.refit(), 180)
})

savedToggleBtn.addEventListener('click', () => {
  settings = { ...settings, savedCollapsed: !settings.savedCollapsed }
  applySidebarLayout()
  persistSettings()
})

// ─── SettingsPanel ───────────────────────────────────────────────
const settingsPanel = new SettingsPanel({
  getSettings,
  setSettings: updateSettings
})
void settingsPanel

// ─── SavedManager（展开管理弹窗） ─────────────────────────────────
function lastTsOf(t: SavedTab): string | undefined {
  let best: string | undefined
  for (const s of t.sessions) {
    const v = s.lastTs ?? s.createdAt
    if (!best || v > best) best = v
  }
  return best
}

const savedManager = new SavedManager({
  getSaved: (): ManageGroupView[] =>
    savedGroups.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      savedAt: s.savedAt,
      tabs: s.snapshot.tabs.map((t) => ({
        id: t.id,
        name: t.name,
        sessions: t.sessions.length,
        savedAt: t.savedAt,
        lastTs: lastTsOf(t)
      }))
    })),
  onReorder: (ids) => {
    const map = new Map(savedGroups.map((s) => [s.id, s]))
    const next: SavedGroup[] = []
    for (const id of ids) {
      const s = map.get(id)
      if (s) next.push(s)
    }
    // 兜底：补回任何漏掉的
    for (const s of savedGroups) if (!ids.includes(s.id)) next.push(s)
    savedGroups.splice(0, savedGroups.length, ...next)
    sidebar.render()
    scheduleSave()
  },
  onRename: (id, name) => {
    const s = savedGroups.find((x) => x.id === id)
    if (!s) return
    s.name = name
    s.snapshot.name = name
    sidebar.render()
    scheduleSave()
  },
  onDelete: (id) => {
    const s = savedGroups.find((x) => x.id === id)
    if (!s) return
    confirmDialog({
      title: `删除已保存的「${s.name}」？`,
      message: '只删除保存记录，不影响当前打开的分组。',
      okLabel: '删除',
      onOk: () => {
        const idx = savedGroups.findIndex((x) => x.id === id)
        if (idx >= 0) savedGroups.splice(idx, 1)
        sidebar.render()
        savedManager.render()
        scheduleSave()
        toast('已删除保存的分组')
      }
    })
  },
  onDeleteTab: (savedId, tabId) => {
    const s = savedGroups.find((x) => x.id === savedId)
    if (!s) return
    const idx = s.snapshot.tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    s.snapshot.tabs.splice(idx, 1)
    sidebar.render()
    scheduleSave()
  },
  onRestoreAll: (id) => restoreSavedAll(id),
  onRestoreSelect: (id) => openRestoreSelect(id),
  getSidebarLimit: () => settings.savedSidebarLimit
})

// ─── 标签历史窗口 ────────────────────────────────────────────────
async function restoreFromHistory(entry: HistoryEntry): Promise<void> {
  // 优先复用已存在的同 cwd 分组（用户语义上：标签回到原分组），找不到就新建一个
  let g = groups.find((x) => x.cwd === entry.cwd)
  if (!g) g = ensureGroup({ name: entry.groupName || entry.cwd, cwd: entry.cwd })
  // tabId 已在 live：直接激活即可，不重复打开
  if (g.tabs.some((t) => t.id === entry.tabId)) {
    activeTabId = entry.tabId
    activateUI(entry.tabId)
    toast(`已切到「${entry.tabName}」`)
    return
  }
  const tab = makeTab(g, {
    id: entry.tabId,
    name: entry.tabName,
    sessions: entry.sessions,
    activeSessionId: entry.activeSessionId,
    autoLaunchCC: entry.autoLaunchCC,
    dirty: true
  })
  activeTabId = tab.id
  sidebar.render()
  activateUI(tab.id)
  await spawnTabPty(tab)
  scheduleSave()
  toast(`已从历史恢复「${entry.tabName}」`)
}

const historyManager = new HistoryManager({
  onRestore: (entry) => void restoreFromHistory(entry)
})

historyOpenBtn?.addEventListener('click', () => void historyManager.open())

// ─── 启动恢复 ────────────────────────────────────────────────────
// 轻量模式：只读 settings + savedGroups，groups/activeTabId 一律不恢复。
// 启动即空状态，等用户点「新建分组」或从已保存的分组恢复。
;(async () => {
  settings = await window.term.loadSettings()
  applySidebarLayout()
  usageIndicator.applySettings(settings.showClaudeUsage)
  const ws = await window.term.loadWorkspace()
  for (const s of ws.savedGroups) {
    savedGroups.push({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      savedAt: s.savedAt,
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
  sidebar.render()
  toolbar.render()
})()
