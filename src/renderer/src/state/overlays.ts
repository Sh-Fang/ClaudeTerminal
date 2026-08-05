// 浮层状态 store：ctx 右键菜单 / modal / confirm / pickTabs / toast / 会话选择浮层，
// 以及各大面板（设置 / 已保存管理 / 历史 / 终端内搜索）的开关。
// 对外保留与原 ui-helpers.ts 完全一致的**命令式 API**（openModal/confirmDialog/showCtxMenu/
// toast/openPickTabs/…），内部只写 zustand 状态，由 <OverlayHost/> 声明式渲染。
// 调用方（controller 等）无需感知 React 的存在，改动最小。
import { create } from 'zustand'

// ─── 类型（从原 ui-helpers.ts 原样搬入） ─────────────────────────

export interface CtxItem {
  label?: string
  icon?: string
  danger?: boolean
  sep?: boolean
  eyebrow?: string // 分组小标题：mono-uppercase 一行，不可点击
  act?: () => void
}

export type ModalKind = 'new-group' | 'new-tab' | 'rename'
export interface ModalInput {
  kind: ModalKind
  title: string
  sub: string
  name: string
  cwd?: string
  showCC?: boolean
  ccChecked?: boolean
  showTabName?: boolean
  tabName?: string
  okLabel?: string
  onPickCwd?: (currentValue: string) => Promise<string | null>
  onOk: (v: { name: string; cwd?: string; autoLaunchCC?: boolean; tabName?: string }) => void
  // true 时：name 字段会跟随 cwd 自动变成路径最后一段；用户一旦动过 name 字段
  // 就停止跟随，避免覆盖用户输入。
  autoNameFromCwd?: boolean
}
// 契约要求的别名：openModal(opts: ModalOpts)
export type ModalOpts = ModalInput

// 原 confirmDialog 的参数（原实现是内联对象类型，这里提名导出）
export interface ConfirmOpts {
  title: string
  message: string // HTML 字符串（含 <b> 等），渲染侧用 dangerouslySetInnerHTML
  okLabel?: string
  danger?: boolean
  onOk: () => void
  onCancel?: () => void
}

// 会话选择浮层条目（勾选恢复弹窗入口① / 管理页入口② 共用）
export interface SessPickEntry {
  sessionId: string
  title: string
  source: string
  ts?: string
  isDefault: boolean // 该标签默认活跃会话（不选就是它）
}

// ─── 选择对话框（用于：从已保存的分组里选要恢复的标签，等场景） ─
export interface PickItem {
  id: string
  label: string
  meta?: string
  disabled?: boolean
  defaultChecked?: boolean
  // 给该行渲染一个文本输入框替代静态 label：用户可以直接输入（如"新建空白标签"
  // 这种行可填名字）。输入框非空时会自动勾选 checkbox。
  // onOk 第二参数 inputs[id] 拿到 input.value.trim()。
  inputPlaceholder?: string
  // 行尾的小垃圾桶：点击触发；和勾选 / label toggle 互不影响。
  // 调用方自己负责二次确认 + 后续刷新（重新调一次 openPickTabs 即可热替换列表）。
  onDelete?: () => void
  deleteTitle?: string
  // 行内附加小复选框：例如"启动 CC"。位置在 meta 之后、del 之前。
  // onOk 的第三参 toggles[id] 拿到当前勾选态。
  sideToggle?: { defaultChecked: boolean; label: string; title?: string }
  // 会话级恢复（入口①）：把 meta 渲染成可点的"会话数"徽标，点开会话小列表。
  // 选一条 = 指定该行用此会话恢复（并自动勾选该行、徽标回显"从「标题」恢复"）；
  // 选"用默认"或取消勾选 = 清除指定。选中/清除通过 onPick 回调告知调用方（sessionId 或 null）。
  // 调用方据此维护 tabId→sessionId 的 override 映射，onOk 后传给恢复逻辑。entries≤1 时不可点。
  sessionPick?: {
    entries: SessPickEntry[]
    onPick: (sessionId: string | null) => void
  }
}
export interface PickTabsCfg {
  title: string
  sub?: string
  items: PickItem[]
  okLabel?: string
  onOk: (selectedIds: string[], inputs: Record<string, string>, toggles: Record<string, boolean>) => void
  onCancel?: () => void
}
// 契约要求的别名：openPickTabs(opts: PickOpts)
export type PickOpts = PickTabsCfg

// 会话选择浮层（点「N 会话」徽标弹出的小列表）参数，签名与原 openSessionPicker 一致
export interface SessionPickerOpts {
  anchor: HTMLElement
  entries: SessPickEntry[]
  selectedId?: string
  onPick: (sessionId: string) => void
  onClear?: () => void
  title?: string
}

export type SavedManagerView = 'groups' | 'workspaces'

// ─── store ──────────────────────────────────────────────────────

interface CtxState {
  items: CtxItem[]
  x: number
  y: number
  onClose: (() => void) | null
  // 下拉式用法（如设置面板的语言/模型 picker）可指定最小宽度对齐触发按钮
  minWidth: number | null
}

interface OverlaysState {
  // modal（新建/重命名弹窗）。seq 每次 openModal 自增 → OverlayHost 借 key 重置内部输入态。
  modal: ModalOpts | null
  modalSeq: number
  // confirm 确认弹窗
  confirm: ConfirmOpts | null
  // ctx 右键菜单
  ctx: CtxState | null
  // toast：隐藏时保留 msg，让淡出过程中文字不消失（对齐原实现只摘 .show 类）
  toastMsg: string
  toastShow: boolean
  // pickTabs 勾选恢复弹窗。seq 语义同 modalSeq：重复 openPickTabs 就地刷新（内容替换不闪）。
  pick: PickOpts | null
  pickSeq: number
  // 会话选择浮层（锚定徽标的小列表）
  sessPick: SessionPickerOpts | null
  // 各大面板开关（组件自行 useOverlays 订阅）
  settingsOpen: boolean
  savedManagerOpen: boolean
  savedManagerView: SavedManagerView | null // 打开时要切到的视图；null = 保持面板当前视图
  historyOpen: boolean
  searchOpen: boolean
}

export const useOverlays = create<OverlaysState>(() => ({
  modal: null,
  modalSeq: 0,
  confirm: null,
  ctx: null,
  toastMsg: '',
  toastShow: false,
  pick: null,
  pickSeq: 0,
  sessPick: null,
  settingsOpen: false,
  savedManagerOpen: false,
  savedManagerView: null,
  historyOpen: false,
  searchOpen: false
}))

// ─── ctx 右键菜单 ────────────────────────────────────────────────

export function showCtxMenu(
  items: CtxItem[],
  x: number,
  y: number,
  onClose?: () => void,
  opts?: { minWidth?: number }
): void {
  // 覆盖式打开：已开着时直接换内容/换位置，旧 onClose 不触发（与原实现一致）
  useOverlays.setState({
    ctx: { items, x, y, onClose: onClose ?? null, minWidth: opts?.minWidth ?? null }
  })
}
export function closeCtxMenu(): void {
  const cur = useOverlays.getState().ctx
  if (!cur) return // 未打开 → 不触发 onClose（原实现按 wasOpen 判定）
  useOverlays.setState({ ctx: null })
  cur.onClose?.()
}

// ─── toast ──────────────────────────────────────────────────────

let toastTimer: number | null = null
export function toast(msg: string): void {
  useOverlays.setState({ toastMsg: msg, toastShow: true })
  // 连点：文字就地替换 + 计时重置（对齐原实现 2600ms）
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    useOverlays.setState({ toastShow: false })
    toastTimer = null
  }, 2600)
}

// ─── confirm ────────────────────────────────────────────────────

export function confirmDialog(opts: ConfirmOpts): void {
  useOverlays.setState({ confirm: opts })
}
export function isConfirmOpen(): boolean {
  return useOverlays.getState().confirm !== null
}
// OverlayHost 用：先隐藏再回调（对齐原实现的时序，回调里可再弹下一个弹窗）
export function resolveConfirm(ok: boolean): void {
  const cur = useOverlays.getState().confirm
  if (!cur) return
  useOverlays.setState({ confirm: null })
  if (ok) cur.onOk()
  else cur.onCancel?.()
}

// ─── modal ──────────────────────────────────────────────────────

export function openModal(cfg: ModalOpts): void {
  useOverlays.setState((s) => ({ modal: cfg, modalSeq: s.modalSeq + 1 }))
}
// 原实现的内部 closeModal（取消/Esc/点外部：只隐藏，不回调）；OverlayHost 用
export function closeModal(): void {
  useOverlays.setState({ modal: null })
}

// ─── pickTabs ───────────────────────────────────────────────────

export function openPickTabs(cfg: PickOpts): void {
  // 重复调用 = 就地刷新：scrim 不摘 hidden，仅换内容（seq 自增让内部勾选态重置）
  useOverlays.setState((s) => ({ pick: cfg, pickSeq: s.pickSeq + 1 }))
}
export function closePickTabs(): void {
  // 对齐原 pkClose：连带关掉可能开着的会话选择浮层
  useOverlays.setState({ pick: null, sessPick: null })
}

// ─── 会话选择浮层 ────────────────────────────────────────────────

export function openSessionPicker(opts: SessionPickerOpts): void {
  useOverlays.setState({ sessPick: opts })
}
export function closeSessionPicker(): void {
  useOverlays.setState({ sessPick: null })
}

// ─── 面板开关 ────────────────────────────────────────────────────

export function openSettings(): void {
  useOverlays.setState({ settingsOpen: true })
}
export function closeSettings(): void {
  useOverlays.setState({ settingsOpen: false })
}

// 原签名 savedManager.open(undefined, view) → 迁移后统一 openSavedManager(view)
export function openSavedManager(view?: SavedManagerView): void {
  useOverlays.setState({ savedManagerOpen: true, savedManagerView: view ?? null })
}
export function closeSavedManager(): void {
  useOverlays.setState({ savedManagerOpen: false, savedManagerView: null })
}

export function openHistory(): void {
  useOverlays.setState({ historyOpen: true })
}
export function closeHistory(): void {
  useOverlays.setState({ historyOpen: false })
}

export function openSearchOverlay(): void {
  useOverlays.setState({ searchOpen: true })
}
export function closeSearchOverlay(): void {
  useOverlays.setState({ searchOpen: false })
}
