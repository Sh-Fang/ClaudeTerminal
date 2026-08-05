// 设置面板（React 版）：由原 settings-panel.ts + index.html #settingsScrim 整块迁移。
// 结构 / id / class 与原静态 DOM 一一对应；开合状态订阅 overlays 的 settings 开关。
// 表单是「打开时从 getSettings() 绑定一次，每次变更整装新 Settings 提交」——
// 与原 bindFromSettings / commitChange 流程一致。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_SETTINGS,
  type Settings,
  type ThemePreset,
  type AppTheme,
  type CursorStyle,
  type UsageStyle,
  type CloseBehavior,
  type TabBarMode,
  type AppLanguage
} from '../themes'
import { useOverlays, closeSettings, confirmDialog, showCtxMenu, closeCtxMenu, type CtxItem } from '../state/overlays'
import { icon } from '../svg-icons'
import { MODEL_GROUPS } from './SessionInfoBar'
import { t } from '../i18n'
import { getSettings, updateSettings } from '../controller'
import { useAppStore } from '../state/store'

// 与 preload/index.ts 的 InstalledCcVersion 同构。不直接 import：preload/index.ts 不在
// tsconfig.web 的文件清单里（web 项目只认 index.d.ts 的全局声明），跨项目 import 会报 TS6307。
interface InstalledCcVersion {
  version: string
  path: string
  installedAt: number
  active: boolean
}

const FOLLOW_CC_LABEL = '跟随 cc 默认'
const CC_PAGE_SIZE = 10

// 简易 semver 比较：与主进程 cc-versions.ts 里保持一致；pre-release 视为更小
function cmpSemver(a: string, b: string): number {
  const [ah, ap = ''] = a.split('-', 2)
  const [bh, bp = ''] = b.split('-', 2)
  const pa = ah.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = bh.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

function clamp(n: number, min: number, max: number, fb: number): number {
  if (!Number.isFinite(n)) return fb
  return Math.min(max, Math.max(min, n))
}

// ─── npm 镜像候选 ────────────────────────────────────────────────
// 国内常用镜像 + npm 官方（配合「使用 npm 镜像」开关：关 = 主进程直接走官方源）。
// name 是词典 key；测速走主进程 npm:ping（渲染层 CSP 不放行外网 fetch）。
const NPM_MIRRORS: { name: string; url: string }[] = [
  { name: '淘宝 npmmirror', url: 'https://registry.npmmirror.com' },
  { name: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/' },
  { name: '华为云', url: 'https://repo.huaweicloud.com/repository/npm/' },
  { name: 'npm 官方', url: 'https://registry.npmjs.org' }
]

function hostOf(u: string): string {
  try { return new URL(u).host } catch { return u }
}

// picker 按钮上显示的当前镜像：预置项显示名称·host，老配置的自定义地址兜底「自定义」
function npmRegLabel(reg: string): string {
  const cur = reg.trim()
  const m = NPM_MIRRORS.find((x) => x.url === cur)
  if (m) return `${t(m.name)} · ${hostOf(m.url)}`
  return `${t('自定义')} · ${hostOf(cur)}`
}

// 时延徽标 HTML（CtxItem.metaHtml）：undefined = 未返回（测速中），-1 = 超时/不通。
// 分级：<100ms 绿 / 100~200 蓝 / 200~500 黄 / >500 红。
function latBadge(ms: number | undefined): string {
  if (ms === undefined) return '<span>…</span>'
  if (ms < 0) return `<span class="lat-bad">${t('超时')}</span>`
  const cls = ms < 100 ? 'lat-fast' : ms < 200 ? 'lat-ok' : ms <= 500 ? 'lat-slow' : 'lat-bad'
  return `<span class="${cls}">${ms}ms</span>`
}

// 面板表单快照：对应原实现里各控件的即时值。文本/数字输入存原始串，
// 提交时才 clamp（与原 commitChange 读 .value 再 clamp 的行为一致，输入框不被改写）。
interface Form {
  family: string
  size: string
  line: string
  scrollback: string
  npmReg: string
  npmMirror: boolean
  theme: string
  appTheme: string
  tabBarMode: string
  usageStyle: string
  downgradeSec: string
  closeBehavior: string
  cursor: CursorStyle
  cursorBlink: boolean
  defaultCC: boolean
  disableUpd: boolean
  showUsage: boolean
  showFloater: boolean
  model: string
  language: AppLanguage
}

// 原 bindFromSettings：Settings → 控件值（含各兜底）
function formFromSettings(s: Settings): Form {
  // 未知的 model arg 兜底到空（跟随 cc 默认）—— 老配置里存了已退役 id 时不至于白屏
  const known = new Set<string>(['', ...MODEL_GROUPS.flatMap((g) => g.rows.map((r) => r.arg))])
  return {
    family: s.font.family,
    size: String(s.font.size),
    line: String(s.font.lineHeight),
    scrollback: String(s.terminal.scrollback),
    npmReg: s.npmRegistry,
    // 老配置没有该字段时兜底开启（现状行为：默认走 npmmirror）
    npmMirror: s.npmMirrorEnabled !== false,
    theme: s.terminal.theme,
    appTheme: s.appTheme,
    // 老配置没有该字段时兜底垂直
    tabBarMode: s.tabBarMode || 'vertical',
    // 老配置没有该字段时兜底进度条，保证进设置一定有选中态
    usageStyle: s.usageStyle || 'bar',
    downgradeSec: String(s.statusDowngradeSec),
    // 老配置没有该字段时兜底「确认后退出」（现状行为）
    closeBehavior: s.closeBehavior || 'quit',
    cursor: s.cursor.style,
    cursorBlink: s.cursor.blink,
    defaultCC: s.defaults.autoLaunchCC,
    disableUpd: s.disableAutoupdater,
    showUsage: s.showClaudeUsage,
    showFloater: s.showFloater,
    model: known.has(s.defaults.model) ? s.defaults.model : '',
    language: s.language || 'zh'
  }
}

// CC 版本管理的内部状态：沿用原 class 字段的可变心智，塞进一个 ref 对象，
// 变更后手动 rerender ——避免异步流程里到处踩 React state 的闭包陈旧坑。
interface CcState {
  installedSet: Set<string>
  installedMap: Map<string, { path: string; active: boolean }>
  remote: string[]
  activeVersion: string // 托管路径命中的版本
  detectedVersion: string // 从 claudePath 反查到的版本（含自定义路径场景）
  installingVer: string
  loaded: boolean
  infoLoaded: boolean // applyInstalled 至少跑过一次（否则「正在使用」卡片显示 —）
  page: number
  // 首次拉完远端后要自动跳到含使用中版本的页；之后用户改 filter/search 时不再自动跳
  autoJumpPending: boolean
  // 安装进度
  installStartTs: number
  installPhase: string
  hintText: string
  hintKind: '' | 'ok' | 'err'
  refreshing: boolean
  search: string
  onlyInstalled: boolean
}

export function SettingsPanel() {
  const open = useOverlays((s) => s.settingsOpen)
  const rev = useAppStore((s) => s.rev)
  void rev // 声明依赖：设置在别处（如版本切换写 claudePath）变化时刷新「正在使用」卡片

  const [form, setForm] = useState<Form>(() => formFromSettings(DEFAULT_SETTINGS))
  // commit 之间可能同 tick 连发（菜单选择等），走 ref 保证读到最新快照
  const formRef = useRef(form)
  formRef.current = form
  const [section, setSection] = useState('appearance')
  const [modelOpen, setModelOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [langHintShown, setLangHintShown] = useState(false)
  const lastDisableUpdRef = useRef<boolean | null>(null)
  const scrimDownRef = useRef(false)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const langBtnRef = useRef<HTMLButtonElement>(null)
  // npm 镜像下拉：时延按 url 记账（undefined = 测速中 / 未测；-1 = 超时）
  const [npmOpen, setNpmOpen] = useState(false)
  const [npmLat, setNpmLat] = useState<Record<string, number | undefined>>({})
  const npmLatRef = useRef(npmLat)
  npmLatRef.current = npmLat
  const npmBtnRef = useRef<HTMLButtonElement>(null)

  // 关于区
  const [aboutVer, setAboutVer] = useState('—')
  const aboutVerLoadedRef = useRef(false)
  const [aboutChecking, setAboutChecking] = useState(false)
  const [aboutHint, setAboutHint] = useState('')

  // CC 版本管理
  const cc = useRef<CcState>({
    installedSet: new Set(),
    installedMap: new Map(),
    remote: [],
    activeVersion: '',
    detectedVersion: '',
    installingVer: '',
    loaded: false,
    infoLoaded: false,
    page: 1,
    autoJumpPending: true,
    installStartTs: 0,
    installPhase: '',
    hintText: '',
    hintKind: '',
    refreshing: false,
    search: '',
    onlyInstalled: false
  }).current
  const [, setCcTick] = useState(0)
  const rerender = (): void => setCcTick((v) => v + 1)
  const ccInstallTickerRef = useRef<number | null>(null)
  const ccInstallPhaseUnsubRef = useRef<(() => void) | null>(null)

  // ─── 提交流程（原 commitChange）────────────────────────────
  function doCommit(f: Form): void {
    const cur = getSettings()
    const next: Settings = {
      // 用 cur 打底，保留面板里没有的字段（lastUsedCwd / sidebarWidth /
      // sidebarCollapsed / savedCollapsed），否则它们会在每次保存时被抹掉。
      ...cur,
      version: 1,
      font: {
        family: f.family.trim() || DEFAULT_SETTINGS.font.family,
        size: clamp(Number(f.size), 8, 40, cur.font.size),
        lineHeight: clamp(Number(f.line), 1.0, 2.0, cur.font.lineHeight)
      },
      cursor: {
        style: f.cursor || cur.cursor.style,
        blink: f.cursorBlink
      },
      terminal: {
        scrollback: clamp(Number(f.scrollback), 100, 100000, cur.terminal.scrollback),
        theme: (f.theme as ThemePreset) || cur.terminal.theme
      },
      appTheme: (f.appTheme as AppTheme) || cur.appTheme,
      tabBarMode: (f.tabBarMode as TabBarMode) || cur.tabBarMode,
      usageStyle: (f.usageStyle as UsageStyle) || cur.usageStyle,
      defaults: {
        // cwd 预填全靠 lastUsedCwd 自动记忆，设置面板不再提供手动默认路径
        cwd: cur.defaults.cwd,
        autoLaunchCC: f.defaultCC,
        model: f.model ?? ''
      },
      // claudePath 由 CC 版本管理 / 首启自动检测维护，面板不直接编辑（...cur 已带上）
      npmRegistry: f.npmReg.trim() || DEFAULT_SETTINGS.npmRegistry,
      npmMirrorEnabled: f.npmMirror,
      disableAutoupdater: f.disableUpd,
      statusDowngradeSec: clamp(Number(f.downgradeSec), 1, 10, cur.statusDowngradeSec),
      showClaudeUsage: f.showUsage,
      showFloater: f.showFloater,
      closeBehavior: (f.closeBehavior as CloseBehavior) || cur.closeBehavior,
      language: f.language || cur.language
    }
    updateSettings(next)
    if (lastDisableUpdRef.current !== null && lastDisableUpdRef.current !== next.disableAutoupdater) {
      void syncSystemEnv(next.disableAutoupdater)
    }
    lastDisableUpdRef.current = next.disableAutoupdater
  }

  function commit(patch: Partial<Form>): void {
    const f = { ...formRef.current, ...patch }
    formRef.current = f
    setForm(f)
    doCommit(f)
  }

  async function syncSystemEnv(enabled: boolean): Promise<void> {
    // 行为保留：写入/移除 Windows 用户环境变量；UI 上不再回显结果
    try {
      await window.term.applyDisableAutoupdater(enabled)
    } catch {}
  }

  // 设置里勾了「禁止自动升级」但系统环境变量还没写（如默认勾选、从未触发过写入）→
  // 补写一次，保持设置与系统状态一致。
  async function ensureUpdConsistency(): Promise<void> {
    try {
      const cur = await window.term.readDisableAutoupdater()
      if (getSettings().disableAutoupdater && cur !== '1') {
        await syncSystemEnv(true)
      }
    } catch {}
  }

  // ─── 打开 / 关闭 ───────────────────────────────────────────
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // 原 open()：bindFromSettings + 回到外观分区 + 环境变量一致性补写
      const s = getSettings()
      const f = formFromSettings(s)
      formRef.current = f
      setForm(f)
      lastDisableUpdRef.current = s.disableAutoupdater
      setSection('appearance')
      void ensureUpdConsistency()
    }
    prevOpenRef.current = open
  }, [open])

  // 打开面板即并发测速全部镜像（含老配置的自定义地址），结果陆续填进 npmLat。
  // 每次打开清空重测——网络环境可能变了，别拿上次的旧数字骗人。
  useEffect(() => {
    if (!open) return
    setNpmLat({})
    const urls = new Set(NPM_MIRRORS.map((m) => m.url))
    const cur = getSettings().npmRegistry.trim()
    if (cur) urls.add(cur)
    for (const url of urls) {
      void window.term.npmPing(url).then((ms) => {
        setNpmLat((prev) => ({ ...prev, [url]: ms }))
      })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // 卸载兜底清理（组件常驻，仅热更/整树卸载时触发）
  useEffect(
    () => () => {
      ccInstallPhaseUnsubRef.current?.()
      if (ccInstallTickerRef.current !== null) clearInterval(ccInstallTickerRef.current)
    },
    []
  )

  function activateSection(name: string): void {
    setSection(name)
    if (name === 'claude') {
      ensureInstallPhaseSub()
      // 首次打开必拉；之后只刷新已安装（远端保持缓存，靠「刷新」按钮显式重拉）
      void refresh(!cc.loaded)
    }
    if (name === 'about' && !aboutVerLoadedRef.current) {
      aboutVerLoadedRef.current = true
      void window.term.appVersion().then((v) => setAboutVer(v))
    }
  }

  // ─── CC 版本管理 ───────────────────────────────────────────
  function ensureInstallPhaseSub(): void {
    if (ccInstallPhaseUnsubRef.current) return
    ccInstallPhaseUnsubRef.current = window.term.onCcInstallPhase(({ version, phase }) => {
      if (version === cc.installingVer) {
        cc.installPhase = phase
        rerender()
      }
    })
  }

  function setCcHint(text: string, kind: '' | 'ok' | 'err'): void {
    cc.hintText = text
    cc.hintKind = kind
  }

  function applyInstalled(list: InstalledCcVersion[], curVer: string | null): void {
    cc.installedSet = new Set(list.map((v) => v.version))
    cc.installedMap = new Map(list.map((v) => [v.version, { path: v.path, active: v.active }]))
    const active = list.find((v) => v.active)
    cc.activeVersion = active?.version ?? ''
    cc.detectedVersion = curVer ?? ''
    cc.infoLoaded = true
  }

  // 拉数据 + 重渲染。fetchRemote=true 时会重新问远端（首次打开或用户点「刷新」）。
  async function refresh(fetchRemote: boolean): Promise<void> {
    if (fetchRemote) {
      cc.refreshing = true
      rerender()
      try {
        const [installed, remoteRes, curVer] = await Promise.all([
          window.term.ccListInstalled(),
          window.term.ccListRemote(),
          window.term.ccCurrentVersion()
        ])
        applyInstalled(installed, curVer)
        if (remoteRes.ok) {
          cc.remote = remoteRes.versions
          cc.loaded = true
          setCcHint('', '')
        } else {
          setCcHint(t('远端版本拉取失败：{0}', t(remoteRes.error ?? '未知')), 'err')
        }
      } finally {
        cc.refreshing = false
      }
    } else {
      const [installed, curVer] = await Promise.all([
        window.term.ccListInstalled(),
        window.term.ccCurrentVersion()
      ])
      applyInstalled(installed, curVer)
    }
    // 首次拉完远端 → 自动跳到含使用中版本的页；用户改 filter 后不再自动跳
    if (fetchRemote && cc.autoJumpPending) {
      const pg = pageOfCurrent()
      if (pg > 0) cc.page = pg
      cc.autoJumpPending = false
    }
    rerender()
  }

  // 合并 + 过滤后的版本序列（供分页与页码计算复用）
  function computeFiltered(): string[] {
    const q = cc.search.trim().toLowerCase()
    const onlyInstalled = cc.onlyInstalled
    const all = new Set<string>(cc.remote)
    for (const v of cc.installedSet) all.add(v)
    if (cc.detectedVersion) all.add(cc.detectedVersion)
    const versions = Array.from(all).sort(cmpSemver).reverse()
    // 「已安装」= 托管的 ∪ 反查到的（自定义路径 / 系统 PATH 里的 claude 都算）
    const isInstalledForFilter = (v: string): boolean =>
      cc.installedSet.has(v) || (!!cc.detectedVersion && v === cc.detectedVersion)
    return versions.filter((v) => {
      if (onlyInstalled && !isInstalledForFilter(v)) return false
      if (q && !v.toLowerCase().includes(q)) return false
      return true
    })
  }

  // 使用中版本在当前过滤序列中所属的页（1-based）；不在或无 => 0
  function pageOfCurrent(): number {
    const target = cc.activeVersion || cc.detectedVersion
    if (!target) return 0
    const list = computeFiltered()
    const idx = list.indexOf(target)
    if (idx < 0) return 0
    return Math.floor(idx / CC_PAGE_SIZE) + 1
  }

  async function activateVersion(path: string): Promise<void> {
    const cur = getSettings()
    if (cur.claudePath === path) return
    const next = { ...cur, claudePath: path }
    updateSettings(next)
    // updateSettings 走 300ms 去抖落盘 —— 但下面 refresh 立即通过 IPC 让主进程读磁盘
    // 拿 claudePath 判断哪版是 active。抢跑就会读到旧值 → UI 显示"没换"。
    // 这里显式 await 一次落盘（幂等，去抖的第二次写入也无副作用），确保 refresh 拿到新值。
    await window.term.saveSettings(next)
    await refresh(false)
  }

  function deleteVersion(version: string): void {
    confirmDialog({
      title: t('卸载 CC 版本'),
      message: t('确定卸载 <b>v{0}</b>？此操作不可恢复。', version),
      okLabel: t('卸载'),
      danger: true,
      onOk: async () => {
        const res = await window.term.ccUninstall(version)
        if (!res.ok) {
          setCcHint(t('卸载失败：{0}', t(res.error ?? '未知')), 'err')
          rerender()
          return
        }
        void refresh(false)
      }
    })
  }

  function confirmInstall(version: string): void {
    if (cc.installingVer) return
    // 使用中·自定义路径的版本安装 → 语义是"备份到托管"，改一下措辞让用户明白目的
    const isBackup =
      !!cc.detectedVersion && version === cc.detectedVersion && !cc.installedSet.has(version)
    const msg = isBackup
      ? t('你现在正用着 <b>v{0}</b>（自定义路径），把它安装到托管一份作为备份？<br>安装期间当前使用不受影响；装完后可通过「启用」在托管副本与自定义路径之间切换。', version)
      : t('即将从 <b>npm 镜像</b> 安装 <b>v{0}</b>。<br>安装过程中会调 npm 下载并解压依赖，可能耗时几十秒。<br>安装中可以点「取消」中止。', version)
    confirmDialog({
      title: isBackup ? t('备份到托管') : t('安装 CC 版本'),
      message: msg,
      okLabel: isBackup ? t('备份') : t('安装'),
      danger: false,
      onOk: () => void installVersion(version)
    })
  }

  async function installVersion(version: string): Promise<void> {
    if (cc.installingVer) return
    cc.installingVer = version
    cc.installStartTs = Date.now()
    cc.installPhase = ''
    setCcHint('', '')
    rerender()
    // 每 700ms 重渲染一次，刷新 installing 行的 meta（elapsed 秒计数）
    ccInstallTickerRef.current = window.setInterval(() => rerender(), 700)
    try {
      const res = await window.term.ccInstall(version)
      // '已取消' 是主进程回传的协议串（保持中文比对，不能翻译后再比）
      if (!res.ok && res.error !== '已取消') {
        setCcHint(t('安装失败：{0}', t(res.error ?? '未知')), 'err')
      }
    } finally {
      if (ccInstallTickerRef.current !== null) {
        clearInterval(ccInstallTickerRef.current)
        ccInstallTickerRef.current = null
      }
      cc.installingVer = ''
      cc.installPhase = ''
      await refresh(false)
    }
  }

  async function cancelInstall(version: string): Promise<void> {
    const res = await window.term.ccInstallCancel(version)
    if (!res.ok) {
      setCcHint(t('取消失败：{0}', t(res.error ?? '未知')), 'err')
      rerender()
    }
    // 成功后 install() 会走 error='已取消' 分支 resolve，走 installVersion 的 finally 收尾
  }

  function formatInstallingMeta(): string {
    const secs = Math.max(0, Math.floor((Date.now() - cc.installStartTs) / 1000))
    const short =
      cc.installPhase && cc.installPhase.length > 60
        ? cc.installPhase.slice(0, 60) + '…'
        : cc.installPhase
    return t('安装中 · {0}s', secs) + (short ? ' · ' + short : '')
  }

  // ─── 模型 / 语言 picker（showCtxMenu 浮层复用）─────────────
  function openModelPicker(): void {
    // 已展开 → 再点收起（closeCtxMenu 触发 onClose 把 open 态翻回 false）
    if (modelOpen) {
      closeCtxMenu()
      return
    }
    const cur = formRef.current.model
    // arg = '' 视为"跟随 cc 默认"。用共享 MODEL_GROUPS 保证与左下芯片候选一致。
    const setVal = (v: string): void => {
      if (formRef.current.model === v) return
      commit({ model: v })
    }
    const items: CtxItem[] = [
      { label: t(FOLLOW_CC_LABEL), icon: cur === '' ? '✓' : '', act: () => setVal('') },
      { sep: true }
    ]
    MODEL_GROUPS.forEach((g, gi) => {
      if (gi > 0) items.push({ sep: true })
      items.push({ eyebrow: g.family })
      for (const r of g.rows) {
        items.push({
          label: r.label,
          icon: r.arg === cur ? '✓' : '',
          act: () => setVal(r.arg)
        })
      }
    })
    const btn = modelBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    // 菜单宽与 picker 对齐，从下方展开；showCtxMenu 会自己夹进视口
    setModelOpen(true)
    showCtxMenu(items, r.left, r.bottom + 4, () => setModelOpen(false), { minWidth: r.width })
  }

  // 下拉选项固定用各自语言显示（简体中文 / English），不随界面语言翻译
  function openLanguagePicker(): void {
    // 已展开 → 再点收起（closeCtxMenu 触发 onClose 把 open 态翻回 false）
    if (langOpen) {
      closeCtxMenu()
      return
    }
    const cur = formRef.current.language || 'zh'
    const setVal = (v: AppLanguage): void => {
      if ((formRef.current.language || 'zh') === v) return
      commit({ language: v })
      promptLanguageRestart()
    }
    const items: CtxItem[] = [
      { label: '简体中文', icon: cur === 'zh' ? '✓' : '', act: () => setVal('zh') },
      { label: 'English', icon: cur === 'en' ? '✓' : '', act: () => setVal('en') }
    ]
    const btn = langBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    setLangOpen(true)
    showCtxMenu(items, r.left, r.bottom + 4, () => setLangOpen(false), { minWidth: r.width })
  }

  // ─── npm 镜像 picker ────────────────────────────────────────
  function npmMenuItems(): CtxItem[] {
    const cur = formRef.current.npmReg.trim()
    const setVal = (v: string): void => {
      if (formRef.current.npmReg.trim() === v) return
      commit({ npmReg: v })
    }
    const lat = npmLatRef.current
    const items: CtxItem[] = NPM_MIRRORS.map((m) => ({
      label: `${t(m.name)} · ${hostOf(m.url)}`,
      icon: cur === m.url ? '✓' : '',
      metaHtml: latBadge(lat[m.url]),
      act: () => setVal(m.url)
    }))
    // 老配置的自定义地址不在预置列表 → 追加一项，保证已有配置可见可选不丢失
    if (cur && !NPM_MIRRORS.some((m) => m.url === cur)) {
      items.push({
        label: `${t('自定义')} · ${hostOf(cur)}`,
        icon: '✓',
        metaHtml: latBadge(lat[cur]),
        act: () => {}
      })
    }
    return items
  }

  function showNpmMenu(): void {
    const btn = npmBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    showCtxMenu(npmMenuItems(), r.left, r.bottom + 4, () => setNpmOpen(false), { minWidth: r.width })
  }

  function openNpmPicker(): void {
    // 已展开 → 再点收起（与语言/模型 picker 同款切换语义）
    if (npmOpen) {
      closeCtxMenu()
      return
    }
    setNpmOpen(true)
    showNpmMenu()
  }

  // 测速结果陆续返回时，若下拉正开着就原位刷新徽标（showCtxMenu 覆盖式打开，不闪不动位）
  useEffect(() => {
    if (npmOpen) showNpmMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npmLat])

  // 语言重启才生效：行内常驻提示（带「立即重启」），再弹一次确认支持立即重启。
  // 提示文案用当前运行语言 —— 那是用户此刻一定看得懂的语言。
  function promptLanguageRestart(): void {
    setLangHintShown(true)
    confirmDialog({
      title: t('切换语言'),
      message: t('语言切换将在重启应用后生效。<br>立即重启？所有终端会话都会被终止。'),
      okLabel: t('立即重启'),
      danger: true,
      onOk: () => window.term.relaunchApp()
    })
  }

  function onReset(): void {
    confirmDialog({
      title: t('恢复默认设置'),
      message: t('确定把所有设置恢复到默认？<br>字体 / 光标 / 主题 / 镜像 等都会被重置。<br>此操作不可撤销。'),
      okLabel: t('恢复'),
      danger: true,
      onOk: () => {
        // 语言不跟随「恢复默认」重置 —— 否则英文用户一键重置后界面变回中文
        const f = formFromSettings({ ...DEFAULT_SETTINGS, language: getSettings().language })
        // 对齐原实现：bindFromSettings 先重置 lastDisableUpd 基线，再 commit —— 重置不触发环境变量同步
        lastDisableUpdRef.current = f.disableUpd
        formRef.current = f
        setForm(f)
        doCommit(f)
      }
    })
  }

  // ─── 渲染辅助 ─────────────────────────────────────────────
  // 通用分段按钮组（原 initSeg/setSeg）：点击切换 active + 提交
  const seg = (
    id: string,
    ariaLabel: string,
    val: string,
    pick: (v: string) => void,
    options: Array<{ v: string; label: string }>,
    compact = false
  ) => (
    <div className={'seg-group' + (compact ? ' seg-compact' : '')} id={id} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.v}
          className={'seg-item' + (val === o.v ? ' active' : '')}
          data-val={o.v}
          type="button"
          role="radio"
          onClick={() => pick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  // 原 buildRow：单行版本条目
  function ccRow(version: string) {
    const installedInfo = cc.installedMap.get(version)
    const isManagedActive = version === cc.activeVersion
    // 放宽：detected 且非 managed active 就算 external active —— 即使托管里也装了同版本，
    // 只要 claudePath 还指向自定义路径，仍然显示为「使用中·自定义路径」；托管副本作为备份
    const isExternalActive =
      !isManagedActive && !!cc.detectedVersion && version === cc.detectedVersion
    const isActive = isManagedActive || isExternalActive
    const isInstalled = !!installedInfo
    const isInstalling = version === cc.installingVer

    let cls = 'cvrow'
    if (isActive) cls += ' active'
    else if (isInstalled) cls += ' installed'
    if (isInstalling) cls += ' installing'

    let metaText = ''
    let metaTitle: string | undefined
    if (isInstalling) {
      metaText = formatInstallingMeta()
    } else if (isManagedActive) {
      metaText = t('使用中')
    } else if (isExternalActive) {
      // external active + 已托管 → 仍是"使用中·自定义路径"，尾巴加个小提示
      metaText = isInstalled ? t('使用中 · 自定义路径 · 已备份到托管') : t('使用中 · 自定义路径')
    } else if (isInstalled) {
      metaText = t('已安装')
      metaTitle = installedInfo!.path
    }

    let actions: ReactNode = null
    if (isInstalling) {
      // 安装中 → 取消
      actions = (
        <button type="button" className="cvrow-btn danger" onClick={() => void cancelInstall(version)}>
          {t('取消')}
        </button>
      )
    } else if (isManagedActive) {
      // 托管使用中：禁止自删自切 —— 无按钮
    } else if (isExternalActive && !isInstalled) {
      // 使用中但没在托管：给「安装」，把当前版本备份到托管，方便以后切回
      actions = (
        <button
          type="button"
          className="cvrow-btn primary"
          title={t('把当前版本装到托管目录一份，方便以后随时切回')}
          disabled={!!cc.installingVer}
          onClick={() => confirmInstall(version)}
        >
          {t('安装')}
        </button>
      )
    } else if (isExternalActive && isInstalled) {
      // 使用中且已在托管：启用 = 把 claudePath 切到托管副本；卸载 = 只删托管副本、不影响外部
      actions = (
        <>
          <button
            type="button"
            className="cvrow-btn primary"
            title={t('把 claude 路径切换到托管副本')}
            onClick={() => void activateVersion(installedInfo!.path)}
          >
            {t('启用')}
          </button>
          <button
            type="button"
            className="cvrow-btn danger"
            title={t('仅删除托管副本，不影响当前正在使用的自定义路径')}
            onClick={() => deleteVersion(version)}
          >
            {t('卸载')}
          </button>
        </>
      )
    } else if (isInstalled) {
      // 普通托管备用版本
      actions = (
        <>
          <button
            type="button"
            className="cvrow-btn primary"
            onClick={() => void activateVersion(installedInfo!.path)}
          >
            {t('启用')}
          </button>
          <button type="button" className="cvrow-btn danger" onClick={() => deleteVersion(version)}>
            {t('卸载')}
          </button>
        </>
      )
    } else {
      actions = (
        <button
          type="button"
          className="cvrow-btn primary"
          disabled={!!cc.installingVer}
          onClick={() => confirmInstall(version)}
        >
          {t('安装')}
        </button>
      )
    }

    return (
      <div className={cls} data-ver={version} key={version}>
        <span className="cvrow-rail" />
        <span className="cvrow-main">
          <span className="cvrow-num">{version}</span>
          {metaText ? (
            <span className="cvrow-meta" title={metaTitle}>
              {metaText}
            </span>
          ) : null}
        </span>
        <span className="cvrow-act">{actions}</span>
      </div>
    )
  }

  // ─── 派生渲染数据 ──────────────────────────────────────────
  // 过滤 + 分页（原 renderList 的页码 clamp 在渲染时就地做）
  const filtered = computeFiltered()
  const ccTotal = filtered.length
  const totalPages = Math.max(1, Math.ceil(ccTotal / CC_PAGE_SIZE))
  if (cc.page > totalPages) cc.page = totalPages
  if (cc.page < 1) cc.page = 1
  const ccSlice = filtered.slice((cc.page - 1) * CC_PAGE_SIZE, (cc.page - 1) * CC_PAGE_SIZE + CC_PAGE_SIZE)
  const ccCurPage = pageOfCurrent()

  // 「正在使用」卡片（原 applyInstalled 里的 innerHTML 拼装）
  const claudePathCur = getSettings().claudePath?.trim() || ''
  const ccCurLabel = !cc.infoLoaded ? (
    <>—</>
  ) : cc.activeVersion ? (
    <>
      <span className="v">v{cc.activeVersion}</span>
      <span className="src">{t('托管路径')}</span>
    </>
  ) : claudePathCur ? (
    cc.detectedVersion ? (
      <>
        <span className="v">v{cc.detectedVersion}</span>
        <span className="src">{t('自定义路径')}</span>
      </>
    ) : (
      <>
        <span className="v">{claudePathCur}</span>
        <span className="src">{t('未识别版本')}</span>
      </>
    )
  ) : (
    <>
      <span className="v">claude</span>
      <span className="src">{t('走系统 PATH')}</span>
    </>
  )

  // 默认模型 picker 文案
  const modelLabel =
    form.model === ''
      ? t(FOLLOW_CC_LABEL)
      : MODEL_GROUPS.flatMap((g) => g.rows).find((r) => r.arg === form.model)?.label ??
        t(FOLLOW_CC_LABEL)

  return (
    <div
      id="settingsScrim"
      className="scrim"
      hidden={!open}
      onMouseDown={(e) => {
        scrimDownRef.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && scrimDownRef.current) closeSettings()
        scrimDownRef.current = false
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t('设置')}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('设置分区')}>
            <button
              className={'set-nav-item' + (section === 'appearance' ? ' active' : '')}
              data-section="appearance"
              type="button"
              onClick={() => activateSection('appearance')}
            >
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 3a9 9 0 0 1 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z" />
                </svg>
              </span>
              {t('外观')}
            </button>
            <button
              className={'set-nav-item' + (section === 'general' ? ' active' : '')}
              data-section="general"
              type="button"
              onClick={() => activateSection('general')}
            >
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
              </span>
              {t('通用')}
            </button>
            <button
              className={'set-nav-item' + (section === 'terminal' ? ' active' : '')}
              data-section="terminal"
              type="button"
              onClick={() => activateSection('terminal')}
            >
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
                  <polyline points="6.5 9 10 12 6.5 15" />
                  <line x1="12.5" y1="15" x2="17.5" y2="15" />
                </svg>
              </span>
              {t('终端')}
            </button>
            <button
              className={'set-nav-item' + (section === 'claude' ? ' active' : '')}
              data-section="claude"
              type="button"
              onClick={() => activateSection('claude')}
            >
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 0-9 9" />
                  <path d="M12 3v9l6 3" />
                </svg>
              </span>
              Claude Code
            </button>
            <button
              className={'set-nav-item' + (section === 'about' ? ' active' : '')}
              data-section="about"
              type="button"
              onClick={() => activateSection('about')}
            >
              <span className="ic">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </span>
              {t('关于')}
            </button>
            <div className="settings-nav-foot">
              <button id="set-reset" className="btn btn-secondary" type="button" onClick={onReset}>
                {t('恢复默认')}
              </button>
              <button id="set-close" className="btn btn-primary" type="button" onClick={() => closeSettings()}>
                {t('完成')}
              </button>
            </div>
          </nav>

          <div className="settings-pane">
            {/* ── 外观 ── */}
            <div className="set-section" data-section="appearance" hidden={section !== 'appearance'}>
              <div className="set-row">
                <label>{t('标签栏')}</label>
                {seg('set-tabbar-mode', t('标签栏布局'), form.tabBarMode, (v) => commit({ tabBarMode: v }), [
                  { v: 'vertical', label: t('垂直标签栏') },
                  { v: 'horizontal', label: t('水平标签栏') }
                ])}
              </div>
              <div className="set-row">
                <label>{t('终端主题')}</label>
                {seg('set-theme', t('终端主题'), form.theme, (v) => commit({ theme: v }), [
                  { v: 'vscode-dark', label: 'VSCode Dark' },
                  { v: 'vercel-dark', label: 'Vercel Dark' },
                  { v: 'one-dark', label: 'One Dark' }
                ])}
              </div>
              <div className="set-row">
                <label>{t('应用主题')}</label>
                {seg('set-app-theme', t('应用主题'), form.appTheme, (v) => commit({ appTheme: v }), [
                  { v: 'light', label: t('浅色') },
                  { v: 'dark', label: t('深色') }
                ])}
              </div>
              <div className="set-row set-row-usage">
                <div className="usage-cell set-row-toggle">
                  <label>{t('显示剩余额度')}</label>
                  <input
                    id="set-show-usage"
                    type="checkbox"
                    checked={form.showUsage}
                    onChange={(e) => commit({ showUsage: e.target.checked })}
                  />
                </div>
                {/* 「额度显示样式」只有在「显示剩余额度」开启时才露出 */}
                <div className="usage-cell" id="set-usage-style-wrap" hidden={!form.showUsage}>
                  <label>{t('额度显示样式')}</label>
                  {seg('set-usage-style', t('额度显示样式'), form.usageStyle, (v) => commit({ usageStyle: v }), [
                    { v: 'bar', label: t('进度条') },
                    { v: 'ring', label: t('圆环') }
                  ])}
                </div>
              </div>
            </div>

            {/* ── 通用 ── */}
            <div className="set-section" data-section="general" hidden={section !== 'general'}>
              <div className="set-row">
                <label>{t('语言 / Language')}</label>
                <button
                  type="button"
                  className={'picker-select' + (langOpen ? ' open' : '')}
                  id="set-language"
                  data-val={form.language}
                  ref={langBtnRef}
                  onClick={(e) => {
                    e.stopPropagation() // 挡掉 ui-helpers 里 document.click 关 ctx 的兜底
                    openLanguagePicker()
                  }}
                >
                  <span className="picker-label">{form.language === 'en' ? 'English' : '简体中文'}</span>
                  <span className="picker-chev" dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }} />
                </button>
                <div className="set-row-hint" id="set-language-hint" hidden={!langHintShown}>
                  {t('语言切换将在重启应用后生效')}
                  <button type="button" className="link-btn" onClick={() => window.term.relaunchApp()}>
                    {t('立即重启')}
                  </button>
                </div>
              </div>
              <div className="set-row set-row-toggle">
                <label>{t('新建标签默认自动启动 Claude Code')}</label>
                <input
                  id="set-default-cc"
                  type="checkbox"
                  checked={form.defaultCC}
                  onChange={(e) => commit({ defaultCC: e.target.checked })}
                />
              </div>
              <div className="set-row">
                <label>{t('完成/待办绿点停留时间')}</label>
                {seg(
                  'set-downgrade-sec',
                  t('绿点停留时间'),
                  form.downgradeSec,
                  (v) => commit({ downgradeSec: v }),
                  Array.from({ length: 10 }, (_, i) => ({ v: String(i + 1), label: `${i + 1}s` })),
                  true
                )}
              </div>
              <div className="set-row set-row-toggle">
                <label>{t('开启悬浮窗（屏幕角落显示待查看 / 待决策 / 运行中 数）')}</label>
                <input
                  id="set-show-floater"
                  type="checkbox"
                  checked={form.showFloater}
                  onChange={(e) => commit({ showFloater: e.target.checked })}
                />
              </div>
              <div className="set-row">
                <label>{t('点击关闭按钮时')}</label>
                {seg('set-close-behavior', t('点击关闭按钮时'), form.closeBehavior, (v) => commit({ closeBehavior: v }), [
                  { v: 'quit', label: t('确认后退出') },
                  { v: 'tray', label: t('收进托盘') }
                ])}
              </div>
            </div>

            {/* ── 终端 ── */}
            <div className="set-section" data-section="terminal" hidden={section !== 'terminal'}>
              <div className="set-row">
                <label>{t('字体族')}</label>
                <input
                  id="set-font-family"
                  className="mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.family}
                  onChange={(e) => commit({ family: e.target.value })}
                />
              </div>
              <div className="set-row two">
                <div>
                  <label>{t('字号 (px)')}</label>
                  <input
                    id="set-font-size"
                    type="number"
                    min="8"
                    max="40"
                    step="1"
                    value={form.size}
                    onChange={(e) => commit({ size: e.target.value })}
                  />
                </div>
                <div>
                  <label>{t('行高')}</label>
                  <input
                    id="set-line-height"
                    type="number"
                    min="1.0"
                    max="2.0"
                    step="0.05"
                    value={form.line}
                    onChange={(e) => commit({ line: e.target.value })}
                  />
                </div>
              </div>
              <div className="set-row">
                <label>{t('光标样式')}</label>
                <div className="seg-group" id="set-cursor-style" role="radiogroup" aria-label={t('光标样式')}>
                  <button
                    className={'seg-item' + (form.cursor === 'block' ? ' active' : '')}
                    data-val="block"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: 'block' })}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="3" width="6" height="8" fill="currentColor" />
                    </svg>
                    <span>block</span>
                  </button>
                  <button
                    className={'seg-item' + (form.cursor === 'underline' ? ' active' : '')}
                    data-val="underline"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: 'underline' })}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="10" width="6" height="2" fill="currentColor" />
                    </svg>
                    <span>underline</span>
                  </button>
                  <button
                    className={'seg-item' + (form.cursor === 'bar' ? ' active' : '')}
                    data-val="bar"
                    type="button"
                    role="radio"
                    onClick={() => commit({ cursor: 'bar' })}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="3" width="2" height="8" fill="currentColor" />
                    </svg>
                    <span>bar</span>
                  </button>
                </div>
              </div>
              <div className="set-row">
                <label>{t('回滚缓冲（行）')}</label>
                <input
                  id="set-scrollback"
                  type="number"
                  min="100"
                  max="100000"
                  step="500"
                  value={form.scrollback}
                  onChange={(e) => commit({ scrollback: e.target.value })}
                />
              </div>
              <div className="set-row set-row-toggle">
                <label>{t('光标闪烁')}</label>
                <input
                  id="set-cursor-blink"
                  type="checkbox"
                  checked={form.cursorBlink}
                  onChange={(e) => commit({ cursorBlink: e.target.checked })}
                />
              </div>
            </div>

            {/* ── Claude Code ── */}
            <div className="set-section" data-section="claude" hidden={section !== 'claude'}>
              <div className="set-row">
                <label>
                  {t('新建会话默认模型（')}
                  <code>--resume</code>
                  {t('不受影响）')}
                </label>
                <button
                  type="button"
                  className={'picker-select' + (modelOpen ? ' open' : '')}
                  id="set-default-model"
                  data-val={form.model}
                  ref={modelBtnRef}
                  onClick={(e) => {
                    e.stopPropagation() // 挡掉 ui-helpers 里 document.click 关 ctx 的兜底
                    openModelPicker()
                  }}
                >
                  <span className={'picker-label' + (form.model === '' ? ' mute' : '')}>{modelLabel}</span>
                  <span className="picker-chev" dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }} />
                </button>
              </div>
              <div className="set-row set-row-toggle">
                <label>{t('禁止 cc 自动升级')}</label>
                <input
                  id="set-disable-update"
                  type="checkbox"
                  checked={form.disableUpd}
                  onChange={(e) => commit({ disableUpd: e.target.checked })}
                />
              </div>

              <div className="set-subhead">{t('版本管理')}</div>
              <div className="set-row set-row-toggle">
                <label>{t('使用 npm 镜像')}</label>
                <input
                  id="set-npm-mirror"
                  type="checkbox"
                  checked={form.npmMirror}
                  onChange={(e) => commit({ npmMirror: e.target.checked })}
                />
              </div>
              {/* 开关开启才露出镜像选择；关闭 = 版本管理走 npm 官方源 */}
              {form.npmMirror && (
                <div className="set-row">
                  <label>{t('npm 镜像')}</label>
                  <button
                    type="button"
                    className={'picker-select' + (npmOpen ? ' open' : '')}
                    id="set-npm-registry"
                    ref={npmBtnRef}
                    onClick={(e) => {
                      e.stopPropagation() // 挡掉 document.click 关 ctx 的兜底
                      openNpmPicker()
                    }}
                  >
                    <span className="picker-label">{npmRegLabel(form.npmReg)}</span>
                    <span className="picker-chev" dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }} />
                  </button>
                </div>
              )}

              <div className="cvcard">
                <div className="cvcard-l">
                  <span className="cvcard-eyebrow">{t('正在使用')}</span>
                  <span className="cvcard-body" id="cc-ver-current-label">
                    {ccCurLabel}
                  </span>
                </div>
              </div>

              <div className="cvtool">
                <div className="cvtool-search">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    id="cc-ver-search"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('搜索版本号')}
                    value={cc.search}
                    onChange={(e) => {
                      cc.search = e.target.value
                      cc.page = 1
                      rerender()
                    }}
                  />
                </div>
                <label className="cvtool-filter">
                  <input
                    type="checkbox"
                    id="cc-ver-only-installed"
                    checked={cc.onlyInstalled}
                    onChange={(e) => {
                      cc.onlyInstalled = e.target.checked
                      cc.page = 1
                      rerender()
                    }}
                  />
                  <span>{t('仅已安装')}</span>
                </label>
                <button
                  id="cc-ver-refresh"
                  className={'cvtool-icon' + (cc.refreshing ? ' spinning' : '')}
                  type="button"
                  title={t('重新拉取版本列表')}
                  aria-label={t('刷新')}
                  disabled={cc.refreshing}
                  onClick={() => void refresh(true)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M23 4v6h-6" />
                    <path d="M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                    <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
                  </svg>
                </button>
              </div>

              <div className="cvlist" id="cc-ver-list" role="listbox">
                {ccTotal === 0 ? (
                  <div className="cvempty">
                    {cc.loaded ? t('没有匹配的版本') : t('点击右上「刷新」从 npm 拉取版本列表')}
                  </div>
                ) : (
                  ccSlice.map((v) => ccRow(v))
                )}
              </div>
              <div className="cvpager" id="cc-ver-pager" hidden={ccTotal === 0}>
                {ccTotal > 0 ? (
                  <>
                    <button
                      type="button"
                      className="cvpager-arrow"
                      title={t('上一页')}
                      disabled={cc.page <= 1}
                      onClick={() => {
                        cc.page--
                        rerender()
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 6-6 6 6 6" />
                      </svg>
                    </button>
                    <span
                      className="cvpager-status"
                      dangerouslySetInnerHTML={{ __html: t('第 <span class="cur">{0}</span> / {1} 页', cc.page, totalPages) }}
                    />
                    <span className="cvpager-spacer" />
                    {/* 使用中版本所在页 → 若不在本页，展示一个小跳转 chip（在本页时不显示，rail + meta 已足够） */}
                    {ccCurPage > 0 && ccCurPage !== cc.page ? (
                      <button
                        type="button"
                        className="cvpager-jump"
                        title={t('跳到第 {0} 页', ccCurPage)}
                        onClick={() => {
                          cc.page = ccCurPage
                          rerender()
                        }}
                      >
                        {t('当前使用版本')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="cvpager-arrow"
                      title={t('下一页')}
                      disabled={cc.page >= totalPages}
                      onClick={() => {
                        cc.page++
                        rerender()
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </button>
                  </>
                ) : null}
              </div>
              <div className={'cc-ver-hint' + (cc.hintKind ? ' ' + cc.hintKind : '')} id="cc-ver-hint">
                {cc.hintText}
              </div>
            </div>

            {/* ── 关于 ── */}
            <div className="set-section" data-section="about" hidden={section !== 'about'}>
              <div className="about-card">
                <span className="about-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="40" height="40" xmlns="http://www.w3.org/2000/svg">
                    <rect x="1" y="2" width="22" height="20" rx="5.5" fill="currentColor" />
                    <polyline points="6.5 9 10 12 6.5 15" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="12.5" y1="15" x2="17.5" y2="15" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </span>
                <div className="about-name">Claude Terminal</div>
                <div className="about-ver">
                  {t('版本')} <span id="about-version">{aboutVer}</span>
                </div>
                {/* 检查更新：目前是壳子，更新服务接入后替换这里的实现 */}
                <button
                  id="about-check-update"
                  className="btn btn-secondary"
                  type="button"
                  disabled={aboutChecking}
                  onClick={() => {
                    setAboutChecking(true)
                    setAboutHint('')
                    window.setTimeout(() => {
                      setAboutChecking(false)
                      setAboutHint(t('更新服务尚未接入，敬请期待。'))
                    }, 900)
                  }}
                >
                  {aboutChecking ? t('检查中…') : t('检查更新')}
                </button>
                <div className="about-hint" id="about-hint">
                  {aboutHint}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
