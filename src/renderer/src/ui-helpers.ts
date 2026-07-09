// 简单 UI 工具：context menu / modal / toast / confirm

// 名称自然比较：参照 Windows 资源管理器的"按名称排序"。
//  · 中文先转拼音（toneless）再比较 —— 否则 zh-Hans-CN collator 会把 latin 字符整体
//    排到 CJK 后面（ICU 的 base 顺序），"Claude" 会跑到所有汉字之后。先转拼音让
//    汉字也变成 latin 字符，再按 zh-Hans-CN 比较 → "Claude/c" 跟 "单/d" 按字母混排。
//  · numeric:true 让 "1xx / 2xx / 10xx" 按数值大小排，而不是字典序 "1 / 10 / 2"。
//  · sensitivity:base 大小写不敏感，与系统直觉一致。
import { pinyin } from 'pinyin-pro'
import { icon } from './svg-icons'
import type { SessionRecord } from './terminal-tab'
const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
function nameSortKey(s: string): string {
  // toneType:'none' 去声调；type:'string' 返回空格连接的字符串。原串作为 tiebreak 后缀。
  const py = pinyin(s, { toneType: 'none', type: 'string', nonZh: 'consecutive' })
  return `${py.toLowerCase()}|${s.toLowerCase()}`
}
export function naturalNameCompare(a: string, b: string): number {
  return NAME_COLLATOR.compare(nameSortKey(a), nameSortKey(b))
}

// 仅当 mousedown 与 mouseup（click）都落在 scrim 自身时触发关闭。
// 防止用户在 modal 里按住选文字 → 拖到外部释放被误判为"点外部"。
export function bindScrimDismiss(scrim: HTMLElement, onDismiss: () => void): void {
  let downOnScrim = false
  scrim.addEventListener('mousedown', (e) => {
    downOnScrim = e.target === scrim
  })
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim && downOnScrim) onDismiss()
    downOnScrim = false
  })
}

const ctxEl = document.getElementById('ctx') as HTMLDivElement
const toastEl = document.getElementById('toast') as HTMLDivElement
const toastMsg = document.getElementById('toastMsg') as HTMLSpanElement
const scrim = document.getElementById('scrim') as HTMLDivElement
const confirmScrim = document.getElementById('confirmScrim') as HTMLDivElement
const cfTitle = document.getElementById('cf-title') as HTMLHeadingElement
const cfMsg = document.getElementById('cf-msg') as HTMLDivElement
const cfOk = document.getElementById('cf-ok') as HTMLButtonElement
const cfCancel = document.getElementById('cf-cancel') as HTMLButtonElement

export interface CtxItem {
  label?: string
  icon?: string
  danger?: boolean
  sep?: boolean
  eyebrow?: string // 分组小标题：mono-uppercase 一行，不可点击
  act?: () => void
}

let ctxCloseCb: (() => void) | null = null
export function showCtxMenu(items: CtxItem[], x: number, y: number, onClose?: () => void): void {
  ctxEl.innerHTML = ''
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div')
      s.className = 'ctx-sep'
      ctxEl.appendChild(s)
      continue
    }
    if (it.eyebrow) {
      const e = document.createElement('div')
      e.className = 'ctx-eyebrow'
      e.textContent = it.eyebrow
      ctxEl.appendChild(e)
      continue
    }
    const el = document.createElement('div')
    el.className = 'ctx-item' + (it.danger ? ' danger' : '')
    el.innerHTML = `<span class="ic">${it.icon ?? ''}</span><span>${escapeHtml(it.label ?? '')}</span>`
    el.addEventListener('click', () => {
      closeCtxMenu()
      it.act?.()
    })
    ctxEl.appendChild(el)
  }
  ctxCloseCb = onClose ?? null
  // 先显示以测尺寸
  ctxEl.classList.add('open')
  const pad = 8
  const w = ctxEl.offsetWidth
  const h = ctxEl.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  const lx = Math.min(Math.max(pad, x), vw - w - pad)
  const ly = Math.min(Math.max(pad, y), vh - h - pad)
  ctxEl.style.left = `${lx}px`
  ctxEl.style.top = `${ly}px`
}
export function closeCtxMenu(): void {
  const wasOpen = ctxEl.classList.contains('open')
  ctxEl.classList.remove('open')
  if (wasOpen && ctxCloseCb) { const cb = ctxCloseCb; ctxCloseCb = null; cb() }
}

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.ctx')) closeCtxMenu()
})

let toastTimer: number | null = null
export function toast(msg: string): void {
  toastMsg.textContent = msg
  toastEl.classList.add('show')
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show')
    toastTimer = null
  }, 2600)
}

// ─── 通用 confirm ─────────────────────────────────────────────
let cfCb: (() => void) | null = null
let cfCancelCb: (() => void) | null = null
export function isConfirmOpen(): boolean {
  return !confirmScrim.hidden
}
export function confirmDialog(opts: {
  title: string
  message: string
  okLabel?: string
  danger?: boolean
  onOk: () => void
  onCancel?: () => void
}): void {
  cfTitle.textContent = opts.title
  cfMsg.innerHTML = opts.message
  cfOk.textContent = opts.okLabel ?? '确认'
  cfOk.className = `btn ${opts.danger === false ? 'btn-primary' : 'btn-danger'}`
  cfCb = opts.onOk
  cfCancelCb = opts.onCancel ?? null
  confirmScrim.hidden = false
}
function cancelConfirm(): void {
  confirmScrim.hidden = true
  const cb = cfCancelCb
  cfCb = null
  cfCancelCb = null
  cb?.()
}
cfCancel.addEventListener('click', cancelConfirm)
cfOk.addEventListener('click', () => {
  confirmScrim.hidden = true
  const cb = cfCb
  cfCb = null
  cfCancelCb = null
  cb?.()
})
bindScrimDismiss(confirmScrim, cancelConfirm)

// ─── 通用 modal 重设：根据用途切换提示 + 字段可见性 + 校验 ─────
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
const modalTitle = document.getElementById('modal-title') as HTMLHeadingElement
const modalSub = document.getElementById('modal-sub') as HTMLParagraphElement
const modalName = document.getElementById('modal-name') as HTMLInputElement
const modalCwd = document.getElementById('modal-cwd') as HTMLInputElement
const modalCwdPick = document.getElementById('modal-cwd-pick') as HTMLButtonElement
const modalCC = document.getElementById('modal-cc') as HTMLInputElement
const modalCwdField = document.getElementById('modal-cwd-field') as HTMLDivElement
const modalCCField = document.getElementById('modal-cc-field') as HTMLDivElement
const modalTabName = document.getElementById('modal-tabname') as HTMLInputElement
const modalTabNameField = document.getElementById('modal-tabname-field') as HTMLDivElement
const modalOk = document.getElementById('modal-ok') as HTMLButtonElement
const modalCancel = document.getElementById('modal-cancel') as HTMLButtonElement

let modalCb: ModalInput['onOk'] | null = null
let modalKind: ModalKind = 'new-group'
let modalPickCb: ModalInput['onPickCwd'] | null = null
let modalShowTabName = false
let modalAutoName = false
let modalNameUserEdited = false

// 取路径最后一段作为默认分组名：D:\Document\工单处理\理科工单 → "理科工单"
// 兼容正反斜杠和末尾斜杠；取不到时回退给空串
function basenameOfPath(p: string): string {
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? ''
}
function maybeSyncNameFromCwd(): void {
  if (!modalAutoName || modalNameUserEdited) return
  const base = basenameOfPath(modalCwd.value)
  if (base) modalName.value = base
}

function syncTabNameVisibility(): void {
  const shouldShow = modalShowTabName && modalCC.checked && modalCCField.style.display !== 'none'
  modalTabNameField.style.display = shouldShow ? '' : 'none'
}

export function openModal(cfg: ModalInput): void {
  modalKind = cfg.kind
  modalTitle.textContent = cfg.title
  modalSub.textContent = cfg.sub
  modalName.value = cfg.name
  modalCwd.value = cfg.cwd ?? ''
  modalCC.checked = cfg.ccChecked ?? true
  modalCwdField.style.display = cfg.cwd !== undefined ? '' : 'none'
  modalCCField.style.display = cfg.showCC ? '' : 'none'
  modalTabName.value = cfg.tabName ?? 'A'
  modalShowTabName = !!cfg.showTabName
  syncTabNameVisibility()
  modalOk.textContent = cfg.okLabel ?? '创建'
  modalPickCb = cfg.onPickCwd ?? null
  modalCwdPick.style.display = modalPickCb ? '' : 'none'
  modalCb = cfg.onOk
  // 自动按 cwd 末段填 name：首次打开就 sync 一次；后续按 cwd 变化继续 sync，
  // 直到用户手动改了 name 为止。
  modalAutoName = !!cfg.autoNameFromCwd
  modalNameUserEdited = false
  if (modalAutoName && modalCwd.value) {
    const base = basenameOfPath(modalCwd.value)
    if (base) modalName.value = base
  }
  scrim.hidden = false
  setTimeout(() => {
    modalName.focus()
    modalName.select()
  }, 0)
}

// 用户在 name 字段动了任意一下 → 标记为已编辑，后续 cwd 变化不再覆盖
modalName.addEventListener('input', () => { modalNameUserEdited = true })
// cwd 字段无论"打字"还是"粘贴"都触发同步
modalCwd.addEventListener('input', maybeSyncNameFromCwd)

modalCC.addEventListener('change', syncTabNameVisibility)
function closeModal(): void {
  scrim.hidden = true
  modalCb = null
}
modalCancel.addEventListener('click', closeModal)
bindScrimDismiss(scrim, closeModal)
modalOk.addEventListener('click', () => {
  if (!modalCb) return
  const v = {
    name: modalName.value.trim(),
    cwd: modalKind === 'new-group' || modalKind === 'new-tab' ? modalCwd.value.trim() : undefined,
    autoLaunchCC: modalKind === 'new-group' || modalKind === 'new-tab' ? modalCC.checked : undefined,
    tabName: modalShowTabName ? modalTabName.value.trim() : undefined
  }
  if (!v.name) {
    modalName.focus()
    return
  }
  const cb = modalCb
  modalCb = null
  scrim.hidden = true
  cb(v)
})
;[modalName, modalCwd, modalTabName].forEach((el) =>
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalOk.click()
    else if (e.key === 'Escape') closeModal()
  })
)

modalCwdPick.addEventListener('click', () => {
  if (!modalPickCb) return
  const cb = modalPickCb
  modalCwdPick.disabled = true
  void cb(modalCwd.value)
    .then((picked) => {
      if (picked) {
        modalCwd.value = picked
        maybeSyncNameFromCwd()
      }
    })
    .catch(() => {})
    .finally(() => {
      modalCwdPick.disabled = false
    })
})

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
}
export interface PickTabsCfg {
  title: string
  sub?: string
  items: PickItem[]
  okLabel?: string
  onOk: (selectedIds: string[], inputs: Record<string, string>, toggles: Record<string, boolean>) => void
  onCancel?: () => void
}
const pickScrim = document.getElementById('pickScrim') as HTMLDivElement
const pkTitle = document.getElementById('pk-title') as HTMLHeadingElement
const pkSub = document.getElementById('pk-sub') as HTMLParagraphElement
const pkList = document.getElementById('pk-list') as HTMLDivElement
const pkToggleAllBtn = document.getElementById('pk-toggle-all') as HTMLButtonElement
const pkCount = document.getElementById('pk-count') as HTMLSpanElement
const pkOk = document.getElementById('pk-ok') as HTMLButtonElement
const pkCancel = document.getElementById('pk-cancel') as HTMLButtonElement
let pkCb: PickTabsCfg['onOk'] | null = null
let pkCancelCb: PickTabsCfg['onCancel'] | null = null
let pkItems: PickItem[] = []
function pkSelected(): string[] {
  return pkItems
    .filter((it) => !it.disabled)
    .filter((it) => {
      const cb = pkList.querySelector(`input[data-pk-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
      return cb?.checked
    })
    .map((it) => it.id)
}
// action 行（id 以 '__' 开头，如"+ 新建空白标签"）：不参与"全选/计数/进度判定"，
// 用户仍可单独勾选或通过输入文字自动勾上 —— 最终提交时照常归入 selectedIds。
function pkIsAction(it: PickItem): boolean {
  return it.id.startsWith('__')
}
function pkUpdateCount(): void {
  const totalReal = pkItems.filter((it) => !it.disabled && !pkIsAction(it)).length
  const curReal = pkSelected().filter((id) => !id.startsWith('__')).length
  const curAll = pkSelected().length   // ok 启用看的是总选中数（含 action 行）
  pkCount.textContent = totalReal === 0 ? '' : `已选 ${curReal} / ${totalReal}`
  pkOk.disabled = curAll === 0
  // 合并按钮：实条目全选 → "取消全选"；否则 → "全选"。无可选实条目时禁用。
  pkToggleAllBtn.textContent = totalReal > 0 && curReal === totalReal ? '取消全选' : '全选'
  pkToggleAllBtn.disabled = totalReal === 0
}
function pkSetAll(checked: boolean): void {
  for (const it of pkItems) {
    if (it.disabled || pkIsAction(it)) continue
    const cb = pkList.querySelector(`input[data-pk-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
    if (cb) cb.checked = checked
  }
  pkUpdateCount()
}
function cssAttr(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}
export function openPickTabs(cfg: PickTabsCfg): void {
  pkTitle.textContent = cfg.title
  pkSub.textContent = cfg.sub ?? ''
  pkSub.style.display = cfg.sub ? '' : 'none'
  pkOk.textContent = cfg.okLabel ?? '确认'
  pkCb = cfg.onOk
  pkCancelCb = cfg.onCancel ?? null
  pkItems = cfg.items
  pkList.innerHTML = ''
  for (const it of cfg.items) {
    // 含 inputPlaceholder 的行不能用 <label>（点 input 会触发 label 的隐式 toggle，
    // 干扰光标定位）。改用 <div>，自己在 checkbox 上绑 change。
    const tag = it.inputPlaceholder ? 'div' : 'label'
    const row = document.createElement(tag)
    row.className = 'pk-row' + (it.disabled ? ' is-disabled' : '')
    if (it.id.startsWith('__')) row.dataset.rowAction = '1'
    const checked = it.defaultChecked !== false && !it.disabled
    const labelHtml = it.inputPlaceholder
      ? `<input type="text" class="pk-input" data-pk-input-id="${escapeHtml(it.id)}" placeholder="${escapeHtml(it.inputPlaceholder)}" autocomplete="off" spellcheck="false" />`
      : `<span class="pk-label">${escapeHtml(it.label)}</span>`
    const deleteHtml = it.onDelete
      ? `<button type="button" class="pk-del" data-pk-del-id="${escapeHtml(it.id)}" title="${escapeHtml(it.deleteTitle ?? '从保存里删除')}" aria-label="删除">${icon('trash', { size: 13 })}</button>`
      : ''
    const sideToggleHtml = it.sideToggle
      ? `<label class="pk-side-toggle" title="${escapeHtml(it.sideToggle.title ?? '')}"><input type="checkbox" data-pk-toggle-id="${escapeHtml(it.id)}" ${it.sideToggle.defaultChecked ? 'checked' : ''} /><span>${escapeHtml(it.sideToggle.label)}</span></label>`
      : ''
    row.innerHTML = `
      <input type="checkbox" data-pk-id="${escapeHtml(it.id)}" ${checked ? 'checked' : ''} ${it.disabled ? 'disabled' : ''} />
      ${labelHtml}
      ${it.meta ? `<span class="pk-meta">${escapeHtml(it.meta)}</span>` : ''}
      ${sideToggleHtml}
      ${deleteHtml}
    `
    row.addEventListener('change', pkUpdateCount)
    if (it.onDelete) {
      const delBtn = row.querySelector(`button[data-pk-del-id="${cssAttr(it.id)}"]`) as HTMLButtonElement | null
      delBtn?.addEventListener('click', (e) => {
        // 阻止 label 的隐式 toggle 与 row 的冒泡
        e.preventDefault()
        e.stopPropagation()
        it.onDelete?.()
      })
    }
    if (it.sideToggle) {
      // 行内 sideToggle 自带 label，正常 click 就 toggle 自己的 checkbox；
      // 但外层若是 <label>（无 inputPlaceholder 的行），点这里会同时触发外层
      // 主 checkbox 的隐式 toggle —— 阻止冒泡，让 sideToggle 独立。
      const sideLabel = row.querySelector('.pk-side-toggle') as HTMLLabelElement | null
      sideLabel?.addEventListener('click', (e) => e.stopPropagation())
    }
    // 文本输入框：非空时自动勾上同行 checkbox，省去用户两步操作
    if (it.inputPlaceholder) {
      const textInput = row.querySelector('.pk-input') as HTMLInputElement | null
      const checkbox = row.querySelector(`input[data-pk-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
      textInput?.addEventListener('input', () => {
        if (!checkbox) return
        checkbox.checked = textInput.value.trim().length > 0
        pkUpdateCount()
      })
    }
    pkList.appendChild(row)
  }
  pkUpdateCount()
  pickScrim.hidden = false
}
function pkClose(): void {
  pickScrim.hidden = true
  pkCb = null
  pkCancelCb = null
  pkItems = []
}
export function closePickTabs(): void {
  pkClose()
}
pkToggleAllBtn.addEventListener('click', () => {
  // 全选 / 取消的判定只看"实条目"，与 pkUpdateCount 保持一致；action 行不参与
  const totalReal = pkItems.filter((it) => !it.disabled && !pkIsAction(it)).length
  const curReal = pkSelected().filter((id) => !id.startsWith('__')).length
  pkSetAll(curReal < totalReal)
})
pkCancel.addEventListener('click', () => {
  const cb = pkCancelCb
  pkClose()
  cb?.()
})
pkOk.addEventListener('click', () => {
  const ids = pkSelected()
  if (ids.length === 0) return
  // 把含 inputPlaceholder 的行的输入值收集起来一并回调
  const inputs: Record<string, string> = {}
  const toggles: Record<string, boolean> = {}
  for (const it of pkItems) {
    if (it.inputPlaceholder) {
      const inp = pkList.querySelector(`input[data-pk-input-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
      if (inp) inputs[it.id] = inp.value.trim()
    }
    if (it.sideToggle) {
      const cb = pkList.querySelector(`input[data-pk-toggle-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
      if (cb) toggles[it.id] = cb.checked
    }
  }
  const cb = pkCb
  pkClose()
  cb?.(ids, inputs, toggles)
})
bindScrimDismiss(pickScrim, () => {
  const cb = pkCancelCb
  pkClose()
  cb?.()
})

// 子序列模糊匹配：needle 的字符按顺序依次出现在 haystack 即算命中（不要求相邻）。
// 例："clat" 命中 "Claude Terminal"（c-l-a-...-t），大小写不敏感。
// 跨多个 haystack 用任一命中 = 整体命中。
export function fuzzyMatch(needle: string, haystacks: string | string[]): boolean {
  const n = needle.trim().toLowerCase()
  if (!n) return true
  const list = Array.isArray(haystacks) ? haystacks : [haystacks]
  for (const raw of list) {
    if (!raw) continue
    const h = raw.toLowerCase()
    let i = 0
    for (let k = 0; k < h.length && i < n.length; k++) {
      if (h.charCodeAt(k) === n.charCodeAt(i)) i++
    }
    if (i === n.length) return true
  }
  return false
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  )
}

export function shortPath(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.length <= 2) return p
  return '…\\' + segs.slice(-2).join('\\')
}

export function formatTs(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  const isYest = d.toDateString() === yest.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `今天 ${hh}:${mm}`
  if (isYest) return `昨天 ${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

export function srcLabel(s: string): string {
  return ({ clear: '/clear 后', startup: '初始', compact: 'compact', resume: '恢复' } as Record<string, string>)[s] || s
}

export function statusLabel(s?: string): string {
  return (
    ({ busy: '运行中', attention: '需要你决策', done: '完成，待查看', idle: '空闲', error: '出错' } as Record<string, string>)[
      s || 'idle'
    ] || '空闲'
  )
}
export function statusShort(s?: string): string {
  return (
    ({ busy: '运行中', attention: '待决策', done: '待查看', error: '错误' } as Record<string, string>)[s || 'idle'] || ''
  )
}

// 会话默认名「会话 N」：N 按 createdAt 排序位置算，不用栈位置。
// resume 会把旧条目挪到栈顶（main.ts:1552），用栈位置的话「会话 1」会跟着移动 → 反直觉。
export function defaultSessionTitle(sess: SessionRecord, sessions: SessionRecord[]): string {
  const sorted = [...sessions].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  const idx = sorted.findIndex((s) => s.sessionId === sess.sessionId)
  return `会话 ${idx >= 0 ? idx + 1 : sessions.length}`
}

export function sessionTitle(sess: SessionRecord, sessions: SessionRecord[]): string {
  return sess.userTitle || defaultSessionTitle(sess, sessions)
}
