import '@xterm/xterm/css/xterm.css'
import { TerminalTab, type SessionRecord } from './terminal-tab'
import { Sidebar, type GroupView, type SavedView } from './sidebar'
import { Toolbar } from './toolbar'
import { SettingsPanel } from './settings-panel'
import { DEFAULT_SETTINGS, type Settings } from './themes'
import {
  closePickTabs,
  confirmDialog,
  defaultSessionTitle,
  escapeHtml,
  formatTs,
  isConfirmOpen,
  naturalNameCompare,
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
  // 普通匹配：暗黄背景 + 亮黄描边
  matchBackground: '#3a3a00',
  matchBorder: '#e5e510',
  matchOverviewRuler: '#e5e510',
  // 当前匹配：换成高饱和亮橙 + 白色描边，跟普通匹配的黄色系拉开对比度，
  // 上下切匹配时一眼能看到"我现在停在哪里"。原方案两者同为黄色系深浅差，肉眼几乎分不出。
  activeMatchBackground: '#ff8800',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ff8800'
}

const hostsEl = document.getElementById('hosts') as HTMLDivElement
const appEl = document.querySelector('.app') as HTMLDivElement
const sidebarEl = document.getElementById('sidebar') as HTMLElement
const sidebarResizer = document.getElementById('sidebarResizer') as HTMLDivElement
const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn') as HTMLButtonElement
const sidebarHandleEl = document.getElementById('sidebarHandle') as HTMLDivElement
const savedSectionEl = document.getElementById('savedSection') as HTMLElement
const savedResizer = document.getElementById('savedResizer') as HTMLDivElement
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

// 标签是否"承载 cc"：勾了自动启动 cc，或实际已经起过 cc 会话（含手动 cct / claude 起的）。
// 关键：autoLaunchCC 只是"新建时的意图"，cct 手动起的会话 autoLaunchCC=false 却有真实会话
// 价值——只看 autoLaunchCC 会把这种 tab 误判成纯 pwsh，dirty / 关闭确认全部漏掉。
function isCcTab(t: TerminalTab): boolean {
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

function applySettingsToAll(): void {
  for (const g of groups) for (const t of g.tabs) t.applySettings(settings)
}

function updateSettings(s: Settings): void {
  const prevFloater = settings.showFloater
  settings = s
  applySettingsToAll()
  usageIndicator.applySettings(settings.showClaudeUsage)
  // 设置里可能改了「已保存分组显示数量」，重渲染让侧边栏与管理弹窗即时反映
  sidebar.render()
  savedManager.render()
  if (prevFloater !== settings.showFloater) {
    window.term.floaterSetEnabled(settings.showFloater)
  }
  if (settings.showFloater) pushFloaterCounts()
  // 去抖落盘（含主进程归一化后回写，可能 clamp 了字段，保持本地一致）——与 persistSettings 同逻辑
  persistSettings()
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function quotePs(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
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
    // 设置里选了默认模型 → 新会话开局带上 --model；--resume 分支刻意不带，
    // 避免覆盖旧会话原有模型（cc 恢复后仍走它自己保存的默认，用户想改用左下芯片手动切）。
    // 只允许字母数字/-/./_，防注入（同时也能挡住"跟随 cc 默认"的空串）
    const model = settings.defaults.model
    const modelArg = /^[A-Za-z0-9._-]+$/.test(model) ? ` --model ${model}` : ''
    cmd = `${invoker}${claudeCmd} --session-id ${newId} --name ${quotePs(tab.name)}${modelArg}${settingsArg}`
  }
  window.term.send(tab.ptyId, cmd + '\r')
}

// 顶栏"启动 CC"按钮入口：在当前纯 pwsh 标签里手动起一次可被 app 接管的 cc 会话。
// 等效于用户手敲 cct（走 shell profile 里的 cct 函数：--session-id 新 uuid --name <tab>
// --settings <hooks>），给不知道 cct 命令的用户一个可视化入口；hook 上报后 onSessionEvent 压栈接管。
function startCcInActiveTab(): void {
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
      },
      onShellCommand: (kind, cmd) => {
        // pwsh shell integration OSC 序列触发 → pwsh 一定在前台（cc 全屏 TUI 会完全屏蔽这些序列）。
        // 顶栏"启动 CC"按钮据此显隐：cc 退出后 pwsh 打 prompt 触发一次 end → 按钮秒回。
        if (tabRef.ccActive) {
          tabRef.ccActive = false
          toolbar.render()
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
        sidebar.render()
        toolbar.render()
        // 状态变化极频繁（每条 pwsh 命令一对），不落 scheduleSave —— 状态本身不会持久化
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
    autoNameFromCwd: true,
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

// 右键菜单"在此处打开 Claude Terminal"入口：直接建 tab，不弹 modal。
// - 同 cwd 已有 live 分组 → 直接往里新建 tab（tab 名为分组内下一个字母）
// - 否则 ensureGroup(name=basename(path))；若 savedGroups 里有同 name+cwd 的已保存分组，
//   把它的 srcId 绑到新建的 live 分组 —— 这样 isGroupDirty 因为新 tab.id 不在快照里 → 分组头
//   会显示黄色 dirty，用户手动"保存分组"就把新 tab 并进去。
// autoLaunchCC 走设置默认值。
function basenameOfPath(p: string): string {
  // 磁盘根（D:\ / D: / D:/）没有"最后一段"，美化成「D 盘」而不是裸盘符 "D:"
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return `${drive[1].toUpperCase()} 盘`
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? p
}

async function openHereWithPath(rawPath: string): Promise<void> {
  const p = (rawPath || '').trim()
  if (!p) return
  // 先校验路径存在，避免右键选中一个已重命名/删除的目录时静默 spawn 失败
  const exists = await window.term.pathExists(p)
  if (!exists) {
    toast(`路径不存在：${p}`)
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
  sidebar.render()
  activateUI(tab.id)
  await spawnTabPty(tab)
  scheduleSave()
  // 把这次选的路径也记成 lastUsedCwd
  if (p !== settings.lastUsedCwd) {
    settings = { ...settings, lastUsedCwd: p }
    void window.term.saveSettings(settings)
  }
  toast(`已在「${g.name}」新建标签`)
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
  if (st !== 'done' && st !== 'attention') return
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
    sidebar.render()
    toolbar.render()
    scheduleSave()
  }, settings.statusDowngradeSec * 1000)
}

// 焦点回到主窗口：如果当前激活的 tab 正好处于 done/attention，按完整 N 秒重启倒计时
function resumeDowngradeIfNeeded(): void {
  if (!activeTabId) return
  const ctx = findTab(activeTabId)
  if (!ctx) return
  maybeStartDowngrade(activeTabId, ctx.tab.status)
}
window.addEventListener('blur', clearDowngradeTimer)
window.addEventListener('focus', resumeDowngradeIfNeeded)

function activateTab(tabId: string): void {
  if (activeTabId === tabId) return
  const ctx = findTab(tabId)
  if (!ctx) return
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, `activateTab ${activeTabId} -> ${tabId}`)
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
  const finalize = (): void => {
    disposeTabInternal(group, tab)
    if (group.tabs.length === 0) {
      const idx = groups.indexOf(group)
      if (idx >= 0) groups.splice(idx, 1)
    }
    sidebar.render()
    toolbar.render()
    scheduleSave()
  }
  // 纯 pwsh 标签且不是分组的最后一个 → 关掉无任何损失，跳过确认
  // （是最后一个仍弹确认，因为会顺带关闭整个分组——这是一个更"重"的操作）
  if (isTabExpendable(tab) && !isLast) {
    finalize()
    return
  }
  confirmDialog({
    title: `关闭标签「${tab.name}」？`,
    message: `该标签下有 <b>${tab.sessions.length}</b> 条会话，关闭后该标签将从分组移除。` +
      (isLast ? '<br/>这是分组「' + escapeHtml(group.name) + '」的最后一个标签，关闭后<b>分组也会被关闭</b>。' : ''),
    okLabel: '关闭标签',
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
  sidebar.render()
  savedManager.render()
  scheduleSave()
  toast(`已保存标签「${tab.name}」`)
}

function closeGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const pureNonCc = isPureNonCcGroup(g)
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
  // 纯 pwsh 分组 + 无 busy → 直接关闭，confirmCloseUnsaved 也无视
  //（该设置保护的是 cc 会话数据，纯 pwsh 没数据可丢）
  if (pureNonCc && busyCount === 0) {
    doClose()
    return
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
  blankName?: string,
  blankAutoLaunchCC?: boolean
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
  // 恢复后焦点切到刚 created 的第一个 —— 用户语义就是"打开这个保存的分组进去看看"。
  // created 为空（点恢复但所有 tab 已在 live 里）才回退到原有 active / 组内首个。
  const firstCreated = created[0]
  if (firstCreated) {
    activeTabId = firstCreated.id
  } else if (!activeTabId) {
    const fb = g.tabs[0]
    if (fb) activeTabId = fb.id
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
      // 默认不勾 —— 用户语义是"看一下要恢复哪些"，避免直接全恢复
      defaultChecked: false,
      deleteTitle: '从保存里删除此标签',
      onDelete: () => deleteSavedTabFromPicker(savedId, t.id, t.name)
    }
  })
  // 末尾追加"新建空白标签"操作项：用户可能只想恢复分组同时顺手开一个空标签。
  // inputPlaceholder 让那行渲染成可输入框，用户可直接打字命名；不输入则用默认字母。
  // sideToggle 控制新标签是否自动启动 CC，默认取设置里的值。
  items.push({
    id: PICK_ACTION_NEW_BLANK,
    label: '',
    defaultChecked: false,
    inputPlaceholder: '+ 新建空白标签（直接输入名字）',
    sideToggle: {
      defaultChecked: settings.defaults.autoLaunchCC,
      label: '启动 CC',
      title: '新建标签是否自动启动 Claude Code；默认值来自「设置 → 新建默认值」'
    }
  })
  openPickTabs({
    title: `恢复「${s.name}」的标签`,
    sub: '勾选要恢复的标签。已在当前分组中的标签会被跳过。',
    items,
    okLabel: '恢复',
    onOk: (ids, inputs, toggles) =>
      void restoreSavedTabs(
        savedId,
        ids,
        inputs[PICK_ACTION_NEW_BLANK],
        toggles[PICK_ACTION_NEW_BLANK]
      )
  })
}

// pick 弹窗里点单个标签的小垃圾桶 → 二次确认 → 从快照里抽掉。
// 删空也保留分组卡片（用户语义：只删标签，不动分组本身；要删整组走右键菜单）。
function deleteSavedTabFromPicker(savedId: string, tabId: string, tabName: string): void {
  const s = savedGroups.find((x) => x.id === savedId)
  if (!s) return
  confirmDialog({
    title: `从保存里移除「${tabName}」？`,
    message: '只把该标签从保存记录里删除，已打开的实例不受影响。',
    okLabel: '删除',
    onOk: () => {
      const idx = s.snapshot.tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      s.snapshot.tabs.splice(idx, 1)
      sidebar.render()
      savedManager.render()
      scheduleSave()
      if (s.snapshot.tabs.length === 0) {
        // 没标签可选了，pick 弹窗也没意义了；分组卡片留着
        closePickTabs()
        toast(`「${s.name}」已没有保存的标签`)
        return
      }
      // 弹窗里就地刷新一遍 —— 复用 openRestoreSelect，不闪不丢焦点。
      openRestoreSelect(savedId)
    }
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
      dedupSavedByNameCwd()
      sidebar.render()
      savedManager.render()
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
  sidebar.render()
  activateUI(newTab.id)
  await spawnTabPty(newTab)
  scheduleSave()
  toast(`已在新标签打开会话「${name}」`)
}

function tabNameForSession(s: SessionRecord): string {
  const raw = s.userTitle || `会话 ${s.sessionId.slice(0, 8)}`
  return raw.length > 20 ? raw.slice(0, 19) + '…' : raw
}

// ─── 栈内会话右键菜单（重命名 / 删除；改完默认同步到 saved） ──────
function openSessionCtx(sessionId: string, x: number, y: number): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const onlyOne = ctx.tab.sessions.length <= 1
  const items: import('./ui-helpers').CtxItem[] = [
    { label: '在新标签页中打开该会话', icon: icon('external-link'), act: () => void openSessionInNewTab(sessionId) },
    { sep: true },
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
  const current = sess.userTitle ?? ''
  openModal({
    kind: 'rename',
    title: '重命名会话',
    sub: '不填就用默认名「会话 N」（N 按创建顺序）。右键菜单可「清除自定义标题」回到默认名。',
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
  const title = sess.userTitle || defaultSessionTitle(sess, tab.sessions)
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

// 把标签手动标成 done（绿点），不启动倒计时；下次"切回"该 tab 才走 maybeStartDowngrade。
// 已经在该 tab 上时不会自动切走，所以也不会起倒计时 —— 绿点一直留着直到你"再次进入"。
function markTabPending(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  ctx.tab.status = 'done'
  ctx.tab.note = undefined
  // 若该 tab 上恰有一个倒计时正在跑（之前已 active），先取消；按用户语义"再次进入才计时"
  if (downgradeTabId === tabId) clearDowngradeTimer()
  sidebar.render()
  toolbar.render()
  scheduleSave()
}

// "标记为已查看"：手动清掉侧栏点（done/attention/error → idle），不用切走 tab 再等降级。
// busy 不清 —— 那是 cc 真在跑，跟"看过没"两回事；idle 本来就没点，直接短路。
function markTabViewed(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const s = ctx.tab.status
  if (s === 'idle' || s === 'busy') return
  ctx.tab.status = 'idle'
  ctx.tab.note = undefined
  if (downgradeTabId === tabId) clearDowngradeTimer()
  sidebar.render()
  toolbar.render()
  scheduleSave()
}

function openTabCtx(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  // 按当前状态语义化切换：
  //   idle → 允许"标记为待查看"（留自己看的标签）
  //   done/attention/error → 允许"标记为已查看"（清点降噪）
  //   busy → 都不给：cc 正在跑，改状态只会掩盖真实进度
  const s = ctx.tab.status ?? 'idle'
  const items: import('./ui-helpers').CtxItem[] = []
  if (s === 'idle') {
    items.push({ label: '标记为待查看', icon: icon('check-square'), act: () => markTabPending(tabId) })
  } else if (s === 'done' || s === 'attention' || s === 'error') {
    items.push({ label: '标记为已查看', icon: icon('square'), act: () => markTabViewed(tabId) })
  }
  showCtxMenu(
    [
      ...items,
      { label: '保存标签', icon: icon('save'), act: () => saveTab(tabId) },
      { sep: true },
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
  // hover 已经能从 saved-row 上直接点删除（带二次确认），整行点击直达 pick 弹窗（
  // 那里能删单个标签），日常用不到批量管理 → 不再在右键里挂"管理本分组"。
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
  // 侧边栏渲染：按名称排序（中文拼音 + 数字自然），与管理弹窗保持一致
  getSaved: (): SavedView[] =>
    [...savedGroups]
      .sort((a, b) => naturalNameCompare(a.name, b.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        cwd: shortPath(s.cwd),
        tabCount: s.snapshot.tabs.length,
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

// 让悬浮窗的计数自动跟着 sidebar 状态同步：sidebar.render 是"任何 tab/分组发生变化"
// 的统一汇聚点，包到它后面省去逐处插桩。
{
  const orig = sidebar.render.bind(sidebar)
  sidebar.render = (): void => {
    orig()
    pushFloaterCounts()
  }
}

const toolbar = new Toolbar({
  getActiveTab: () => {
    const ctx = activeContext()
    if (!ctx) return null
    return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
  },
  switchSession: (id) => void switchSession(id),
  onSessionCtx: openSessionCtx,
  startCcHere: () => startCcInActiveTab()
})

// 外部切模型/思考强度（B 方案）：往当前活跃 tab 的 cc 注入斜杠命令。
// 前置校验：无活跃会话、或 cc 正忙（busy=正回复会排队，attention=有权限弹窗会误答）都拒绝。
function activeCcTabForInject(): TerminalTab | null {
  const ctx = activeContext()
  if (!ctx) return null
  const { tab } = ctx
  if (tab.ptyId == null || !tab.activeSessionId) {
    toast('当前标签没有活跃的 Claude 会话')
    return null
  }
  if (tab.status === 'busy' || tab.status === 'attention') {
    toast('Claude 正忙，请等当前回合结束再切换')
    return null
  }
  return tab
}

// 先 Ctrl-U(\x15) 清掉输入行里可能的半截文字，避免和命令拼在一起；再发命令 + 回车。
function injectSlash(tab: TerminalTab, line: string): void {
  window.term.send(tab.ptyId!, '\x15' + line + '\r')
  tab.term.focus()
  sessionInfo.nudge() // 模型/effort 由 cc statusline 秒级回报，催一次让状态栏早点回显
}

// /model 带参 → 直接切、不弹选择器；cc 会把它存成新会话默认，故切一次即持久，无需改 launchCC。
// arg 为 alias（最新）或完整 model id（钉版本，退役会在终端报错）。
function switchActiveModel(arg: string, label: string): void {
  const tab = activeCcTabForInject()
  if (!tab) return
  injectSlash(tab, '/model ' + arg)
  toast('已切换模型 → ' + label)
}

// /effort 带参直接设当前会话思考强度（不持久，属会话级）。
function switchActiveEffort(level: string): void {
  const tab = activeCcTabForInject()
  if (!tab) return
  injectSlash(tab, '/effort ' + level)
  toast('已切换思考强度 → ' + level)
}

const sessionInfo = new SessionInfoBar({
  getActive: () => {
    const ctx = activeContext()
    if (!ctx) return null
    return { sessionId: ctx.tab.activeSessionId ?? null, cwd: ctx.group.cwd }
  },
  requestModelSwitch: switchActiveModel,
  requestEffortSwitch: switchActiveEffort
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
    sidebar.render()
    toolbar.render()
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
// 拖窗口时 ResizeObserver 会高频回调，逐帧 refit → 逐帧把 cols push 给 PTY → cc 每帧收
// SIGWINCH 重画，既抖又费；每次 cols 变化还会惊动一次 ConPTY reflow（xterm 侧的 disableReflow
// 够不着它）。这里 trailing 去抖：拖动过程只等 CSS 吃满，停手 ~120ms 后一次性 refit 到位，把中间
// 一连串 resize 合并成一次，顺带把 ConPTY reflow 的触发次数压到最少。
let roTimer: number | null = null
const ro = new ResizeObserver(() => {
  if (roTimer != null) window.clearTimeout(roTimer)
  roTimer = window.setTimeout(() => {
    roTimer = null
    activeContext()?.tab.refit()
  }, 120)
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

// ─── 关闭 app 时确认（兜底：任何情况都弹一次） ─────────────────────
// 有脏分组且开启对应设置时展示分组明细；其他情况仍弹一个通用确认，防止误关。
window.term.onWindowCloseRequest(() => {
  if (isConfirmOpen()) return // 已有确认弹窗在显示，忽略重复触发
  const dirtyGroups = groups.filter((g) => isGroupDirty(g) && g.tabs.length > 0)
  const showDirty = dirtyGroups.length > 0 && settings.confirmCloseUnsaved
  if (showDirty) {
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
    return
  }
  confirmDialog({
    title: '确认关闭 Claude Terminal？',
    message: '关闭后所有终端会话将被终止。确认继续？',
    okLabel: '关闭',
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
  // 已保存区高度：0 = 不写变量走 CSS 默认 40%；否则按像素值套用
  if (settings.sidebarSavedHeight > 0) {
    document.documentElement.style.setProperty('--saved-h', `${settings.sidebarSavedHeight}px`)
  } else {
    document.documentElement.style.removeProperty('--saved-h')
  }
  // 折叠态下拉条没意义：隐藏并禁用 pointer，避免误拖
  savedResizer.classList.toggle('disabled', settings.savedCollapsed)
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

// 已保存 ↔ 打开 之间的水平拉条：调 .side-saved 高度，剩余给 .side-open（flex:1 自动吃满）
savedResizer.addEventListener('mousedown', (e) => {
  if (settings.savedCollapsed || settings.sidebarCollapsed) return
  e.preventDefault()
  document.body.classList.add('row-resizing')
  savedResizer.classList.add('dragging')
  const startY = e.clientY
  const startH = savedSectionEl.getBoundingClientRect().height
  const sidebarH = sidebarEl.getBoundingClientRect().height
  // 留 100px 给「打开的分组」最少空间，避免被挤没
  const minH = 80
  const maxH = Math.max(minH, sidebarH - 100)
  const onMove = (ev: MouseEvent): void => {
    // 向上拖（clientY 变小）= 已保存区变大
    const dy = startY - ev.clientY
    const h = Math.max(minH, Math.min(maxH, Math.round(startH + dy)))
    settings = { ...settings, sidebarSavedHeight: h }
    document.documentElement.style.setProperty('--saved-h', `${h}px`)
  }
  const onUp = (): void => {
    document.body.classList.remove('row-resizing')
    savedResizer.classList.remove('dragging')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    persistSettings()
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
  // 管理弹窗渲染：按名称排序（与侧边栏一致）。底层 savedGroups 数组顺序不动 ——
  // 排序在展示层做，已经不依赖手动拖动了。
  getSaved: (): ManageGroupView[] =>
    [...savedGroups]
      .sort((a, b) => naturalNameCompare(a.name, b.name))
      .map((s) => ({
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
  onRename: (id, name) => {
    const s = savedGroups.find((x) => x.id === id)
    if (!s) return
    s.name = name
    s.snapshot.name = name
    dedupSavedByNameCwd()
    sidebar.render()
    savedManager.render()
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
    savedManager.render()
    scheduleSave()
  },
  onRestoreAll: (id) => restoreSavedAll(id),
  onRestoreSelect: (id) => openRestoreSelect(id)
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
  // 历史数据可能有同名同路径的重复条目（之前没合并），启动时统一收拢
  dedupSavedByNameCwd()
  sidebar.render()
  toolbar.render()
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
})()
