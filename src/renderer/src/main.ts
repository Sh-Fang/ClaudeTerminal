import '@xterm/xterm/css/xterm.css'
import { TerminalTab, type SessionRecord } from './terminal-tab'
import { Sidebar, type GroupView, type SavedView } from './sidebar'
import { Toolbar } from './toolbar'
import { SettingsPanel } from './settings-panel'
import { DEFAULT_SETTINGS, type Settings } from './themes'
import {
  confirmDialog,
  formatTs,
  openModal,
  shortPath,
  showCtxMenu,
  toast
} from './ui-helpers'
import { icon } from './svg-icons'

const SEARCH_DECOR = {
  matchBackground: '#3a3a00',
  matchBorder: '#e5e510',
  matchOverviewRuler: '#e5e510',
  activeMatchBackground: '#5a4a00',
  activeMatchBorder: '#f5f543',
  activeMatchColorOverviewRuler: '#f5f543'
}

const hostsEl = document.getElementById('hosts') as HTMLDivElement

// ─── 状态 ───────────────────────────────────────────────────────────
interface Group {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

interface SavedGroup {
  id: string
  name: string
  cwd: string
  savedAt: string
  tabCount: number
  snapshot: {
    name: string
    cwd: string
    tabs: Array<{
      name: string
      sessions: SessionRecord[]
      activeSessionId?: string
      autoLaunchCC: boolean
    }>
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
        tabCount: s.tabCount,
        srcId: s.srcId,
        snapshot: {
          id: s.srcId || s.id,
          name: s.snapshot.name,
          cwd: s.snapshot.cwd,
          collapsed: false,
          tabs: s.snapshot.tabs.map((t) => ({
            id: uid('t_'), // 占位（恢复时会重生成）
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

// ─── 启动 cc ───────────────────────────────────────────────────────
async function launchCC(tab: TerminalTab): Promise<void> {
  if (!tab.autoLaunchCC) return
  if (tab.ptyId == null) return

  const claudeBin = settings.claudePath.trim()
  if (!claudeBin) {
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
      settings
    },
    {
      copySelectionAsAnswer: () => false,
      openSearch,
      onRequestNewTab: () => promptNewTabInGroup(group.id),
      onRequestCloseSelf: () => closeTab(id),
      onPtyStarted: () => void launchCC(tabRef)
    }
  )
  group.tabs.push(tabRef)
  tabRef.mount(hostsEl)
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
  openModal({
    kind: 'new-group',
    title: '新建分组',
    sub: '分组以路径为单位。组内可挂多个标签。',
    name: '新分组',
    cwd: settings.defaults.cwd,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    okLabel: '创建',
    onOk: async (v) => {
      const cwd = v.cwd?.trim() || ''
      const g = ensureGroup({ name: v.name, cwd })
      sidebar.render()
      const tab = makeTab(g, { name: 'A', autoLaunchCC: v.autoLaunchCC })
      activeTabId = tab.id
      activateUI(tab.id)
      await spawnTabPty(tab)
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

function activateTab(tabId: string): void {
  if (activeTabId === tabId) return
  const ctx = findTab(tabId)
  if (!ctx) return
  activeTabId = tabId
  // 查看即「已处理」：把醒目状态降级回 idle 视觉态（hook 之后会自然刷新）
  if (ctx.tab.status === 'attention' || ctx.tab.status === 'done') {
    ctx.tab.status = 'idle'
    ctx.tab.note = undefined
  }
  activateUI(tabId)
  scheduleSave()
}

function closeTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { group, tab } = ctx
  const idxInGroup = group.tabs.indexOf(tab)
  group.tabs.splice(idxInGroup, 1)
  tab.dispose()
  if (group.tabs.length === 0) {
    // 空组不自动删除（保留留作 cwd 工作流容器），但若全空、整个 workspace 空则补一个默认分组
  }
  if (activeTabId === tabId) {
    const next = pickNextActive(group, idxInGroup)
    activeTabId = next?.id ?? null
    if (next) activateUI(next.id)
  }
  if (groups.every((g) => g.tabs.length === 0) && groups.length === 0) {
    // 没分组也没标签时，提示新建
  }
  sidebar.render()
  toolbar.render()
  scheduleSave()
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
      sidebar.render()
      toolbar.render()
      scheduleSave()
      toast('已重命名分组')
    }
  })
}

function saveGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const snapshot = {
    name: g.name,
    cwd: g.cwd,
    tabs: g.tabs.map((t) => ({
      name: t.name,
      sessions: t.sessions.map((s) => ({ ...s })),
      activeSessionId: t.activeSessionId,
      autoLaunchCC: t.autoLaunchCC
    }))
  }
  const existing = savedGroups.find((s) => s.srcId === g.id)
  const rec: SavedGroup = {
    id: existing?.id ?? uid('sv_'),
    name: g.name,
    cwd: g.cwd,
    savedAt: new Date().toISOString(),
    tabCount: g.tabs.length,
    snapshot,
    srcId: g.id
  }
  if (existing) Object.assign(existing, rec)
  else savedGroups.unshift(rec)
  sidebar.render()
  scheduleSave()
  toast(`已保存「${g.name}」（${g.tabs.length} 个标签）`)
}

function closeGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const saved = savedGroups.some((s) => s.srcId === g.id)
  confirmDialog({
    title: `关闭分组「${g.name}」？`,
    message: `将关闭该分组下的 ${g.tabs.length} 个标签。` +
      (saved
        ? '该分组<b>已保存</b>，之后可在「已保存的分组」一键恢复。'
        : '该分组<b>尚未保存</b>，关闭后将无法恢复其标签布局。'),
    okLabel: '关闭分组',
    onOk: () => {
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
  })
}

async function restoreSaved(savedId: string): Promise<void> {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  const g = ensureGroup({ name: s.name, cwd: s.cwd })
  const tabs: TerminalTab[] = []
  for (const t of s.snapshot.tabs) {
    const created = makeTab(g, {
      name: t.name,
      sessions: t.sessions,
      activeSessionId: t.activeSessionId,
      autoLaunchCC: t.autoLaunchCC
    })
    tabs.push(created)
  }
  if (tabs.length > 0) {
    activeTabId = tabs[0].id
  }
  sidebar.render()
  toolbar.render()
  // 逐个 PTY 起，恢复 cc resume
  for (const t of tabs) await spawnTabPty(t)
  scheduleSave()
  toast(`已恢复「${s.name}」的 ${tabs.length} 个标签`)
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
      sidebar.render()
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
      sidebar.render()
      scheduleSave()
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
      { label: '关闭标签', icon: icon('close'), danger: true, act: () => closeTab(tabId) }
    ],
    x,
    y
  )
}

function openSavedCtx(savedId: string, x: number, y: number): void {
  showCtxMenu(
    [
      { label: '一键恢复分组', icon: icon('rotate-ccw'), act: () => void restoreSaved(savedId) },
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
  getGroups: (): GroupView[] => groups,
  getSaved: (): SavedView[] =>
    savedGroups.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: shortPath(s.cwd),
      tabCount: s.tabCount,
      savedAt: formatTs(s.savedAt)
    })),
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
  restoreSaved: (id) => void restoreSaved(id)
})

const toolbar = new Toolbar({
  getActiveTab: () => {
    const ctx = activeContext()
    if (!ctx) return null
    return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
  },
  switchSession: (id) => void switchSession(id)
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
const offSession = window.term.onSessionEvent((ev) => {
  const ctx = findTab(ev.tabId)
  if (!ctx) return
  const { tab } = ctx
  const top = tab.sessions[tab.sessions.length - 1]?.sessionId
  if (ev.sessionId === top) {
    if (tab.activeSessionId !== ev.sessionId) {
      tab.activeSessionId = ev.sessionId
      scheduleSave()
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
  scheduleSave()
  sidebar.render()
  toolbar.render()
  void refreshSessionMeta(tab)
})

// ─── 状态徽标事件 ────────────────────────────────────────────────
const offState = window.term.onStateEvent((ev) => {
  const ctx = findTab(ev.tabId)
  if (!ctx) return
  ctx.tab.status = ev.state
  ctx.tab.note = ev.message
  // 如果用户正盯着这个 tab，对 done/attention 视觉降级（hook 后续事件会再次拉回）
  if (activeTabId === ev.tabId && (ev.state === 'done' || ev.state === 'attention')) {
    setTimeout(() => {
      if (ctx.tab.status === ev.state && activeTabId === ev.tabId) {
        // 保留状态值（持久化时可恢复），只在 UI 上若过 5s 仍未变化则降级为 idle
      }
    }, 0)
  }
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
  for (const g of groups) for (const t of g.tabs) t.dispose()
})

// ─── SettingsPanel ───────────────────────────────────────────────
const settingsPanel = new SettingsPanel({
  getSettings,
  setSettings: updateSettings
})
void settingsPanel

// ─── 启动恢复 ────────────────────────────────────────────────────
// 轻量模式：只读 settings + savedGroups，groups/activeTabId 一律不恢复。
// 启动即空状态，等用户点「新建分组」或从已保存的分组恢复。
;(async () => {
  settings = await window.term.loadSettings()
  const ws = await window.term.loadWorkspace()
  for (const s of ws.savedGroups) {
    savedGroups.push({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      savedAt: s.savedAt,
      tabCount: s.tabCount,
      srcId: s.srcId,
      snapshot: {
        name: s.snapshot.name,
        cwd: s.snapshot.cwd,
        tabs: s.snapshot.tabs.map((t) => ({
          name: t.name,
          sessions: t.sessions,
          activeSessionId: t.activeSessionId,
          autoLaunchCC: t.autoLaunchCC !== false
        }))
      }
    })
  }
  sidebar.render()
  toolbar.render()
})()
