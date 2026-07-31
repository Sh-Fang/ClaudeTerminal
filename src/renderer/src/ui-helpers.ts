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

// 两个 ISO 时间串的「新→旧」比较。ISO 串字典序即时序，直接比即可。
export function recencyDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

// 名称的拼音首字母（a-z），非字母开头（数字/符号）归到 '#'。
// 与 naturalNameCompare 同一套拼音转换，保证 A~Z 跳转条和排序结果对得上。
export function nameInitial(s: string): string {
  const py = pinyin(s.trim(), { toneType: 'none', type: 'string', nonZh: 'consecutive' })
  const ch = py.trim().charAt(0).toLowerCase()
  return /[a-z]/.test(ch) ? ch : '#'
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
// 兼容正反斜杠和末尾斜杠；磁盘根（D:\ 等）没有最后一段，美化成「D 盘」；取不到时回退空串
function basenameOfPath(p: string): string {
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return `${drive[1].toUpperCase()} 盘`
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? ''
}
function maybeSyncNameFromCwd(): void {
  if (!modalAutoName || modalNameUserEdited) return
  const base = basenameOfPath(modalCwd.value)
  if (base) modalName.value = base
}

// 首个标签名与 CC 开关相互独立：新建分组必然要建首个标签（不管启不启 CC），
// 字段是否出现只由调用方的 showTabName 决定。
function syncTabNameVisibility(): void {
  modalTabNameField.style.display = modalShowTabName ? '' : 'none'
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
// 入口①：每行已指定的会话（id → {sessionId, 展示标题}）。开弹窗时清空。
const pkSessChosen = new Map<string, { sid: string; title: string }>()
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
  pkSessChosen.clear()
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
    // meta：会话可点(sessionPick 且有≥1条重命名会话)时渲染成徽标按钮，否则普通静态文本。
    // entries 已在上游过滤为"重命名过的会话"，配合选择器里的"用默认会话恢复"即可选择。
    const canPickSess = !!it.sessionPick && it.sessionPick.entries.length >= 1
    const metaHtml = canPickSess
      ? `<button type="button" class="pk-meta pk-sess-count" data-pk-sess-id="${escapeHtml(it.id)}" title="选择要恢复的会话">${escapeHtml(it.meta ?? '')} ▾</button>`
      : it.meta
        ? `<span class="pk-meta">${escapeHtml(it.meta)}</span>`
        : ''
    row.innerHTML = `
      <input type="checkbox" data-pk-id="${escapeHtml(it.id)}" ${checked ? 'checked' : ''} ${it.disabled ? 'disabled' : ''} />
      ${labelHtml}
      ${metaHtml}
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
    // 会话数徽标：点开会话小列表，选一条 = 指定该行用此会话恢复 + 自动勾选 + 徽标回显
    if (canPickSess) {
      const badge = row.querySelector(`[data-pk-sess-id="${cssAttr(it.id)}"]`) as HTMLButtonElement | null
      const checkbox = row.querySelector(`input[data-pk-id="${cssAttr(it.id)}"]`) as HTMLInputElement | null
      const defaultMeta = it.meta ?? ''
      const resetBadge = (): void => {
        if (badge) {
          badge.textContent = `${defaultMeta} ▾`
          badge.title = '选择要恢复的会话'
        }
        badge?.classList.remove('chosen')
      }
      badge?.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openSessionPicker({
          anchor: badge,
          entries: it.sessionPick!.entries,
          selectedId: pkSessChosen.get(it.id)?.sid,
          title: '选择要恢复的会话',
          onPick: (sid) => {
            const ent = it.sessionPick!.entries.find((x) => x.sessionId === sid)
            pkSessChosen.set(it.id, { sid, title: ent?.title ?? sid.slice(0, 8) })
            if (checkbox) checkbox.checked = true
            if (badge) {
              // 标题可能很长会撑爆整行：截断显示 + 完整放 title，末尾保留 ▾ 标记
              const full = ent?.title ?? ''
              const short = full.length > 14 ? full.slice(0, 14) + '…' : full
              badge.textContent = `从「${short}」恢复 ▾`
              badge.title = `从「${full}」恢复`
              badge.classList.add('chosen')
            }
            it.sessionPick!.onPick(sid)
            pkUpdateCount()
          },
          onClear: () => {
            pkSessChosen.delete(it.id)
            resetBadge()
            it.sessionPick!.onPick(null) // 清除指定，仍按默认会话恢复该标签（不改勾选态）
          }
        })
      })
      // 手动取消勾选该行 → 一并清除已指定的会话
      checkbox?.addEventListener('change', () => {
        if (!checkbox.checked && pkSessChosen.has(it.id)) {
          pkSessChosen.delete(it.id)
          resetBadge()
          it.sessionPick!.onPick(null)
        }
      })
    }
    pkList.appendChild(row)
  }
  pkUpdateCount()
  pickScrim.hidden = false
}
function pkClose(): void {
  closeSessionPicker()
  pickScrim.hidden = true
  pkCb = null
  pkCancelCb = null
  pkItems = []
  pkSessChosen.clear()
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

// ─── 模糊搜索：评分 + 空格分词(AND) + 拼音(中文) + 命中高亮 ──────────────
// fuzzySearch(query, fields) 返回命中分数与每个 field 的高亮区间；不命中返回 null。
//  · 空格把 query 拆成多个词，每个词都必须命中某个 field（AND）。
//  · 每个词优先「连续子串」命中（高分），退而求「子序列」命中（低分）；词首/字段首加权。
//  · 中文字段额外按拼音建索引：输入 "lkgd" 能命中「理科工单」，命中回映到原字符做高亮。
//  · 结果分数供调用方倒序排列；高亮区间供 highlightRanges 渲染。
export type Range = [number, number] // [start, end) 原始字符下标

const SEP_RE = /[\s\-_/\\.,:：·|]/
const CJK_RE = /[一-鿿]/

// 一个字段的检索索引：raw = 小写原串（下标即原下标）；pyFlat = 拼音展开串，pyMap 把
// pyFlat 下标映射回原字符下标。无中文时 pyFlat 置空，避免和 raw 重复匹配。
interface Hay {
  raw: string
  pyFlat: string
  pyMap: number[]
}
const hayCache = new Map<string, Hay>()
function buildHay(text: string): Hay {
  const cached = hayCache.get(text)
  if (cached) return cached
  let pyFlat = ''
  const pyMap: number[] = []
  let hasCJK = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (CJK_RE.test(ch)) {
      hasCJK = true
      const py = pinyin(ch, { toneType: 'none', type: 'string', nonZh: 'removed' }).toLowerCase() || ch.toLowerCase()
      for (const c of py) { pyFlat += c; pyMap.push(i) }
    } else {
      pyFlat += ch.toLowerCase()
      pyMap.push(i)
    }
  }
  const hay: Hay = { raw: text.toLowerCase(), pyFlat: hasCJK ? pyFlat : '', pyMap }
  if (hayCache.size > 2000) hayCache.clear() // 简单封顶，防长会话无限增长
  hayCache.set(text, hay)
  return hay
}

function isBoundary(flat: string, pos: number): boolean {
  return pos === 0 || SEP_RE.test(flat[pos - 1])
}

// 单个词在一条 flat 串里的最佳命中，返回 { score, positions(flat 下标) } 或 null。
function matchInFlat(term: string, flat: string): { score: number; positions: number[] } | null {
  if (!term) return { score: 0, positions: [] }
  // 1) 连续子串：质量最高，取「词首加权 + 越靠前越好」的最佳一处
  let best: { score: number; positions: number[] } | null = null
  for (let idx = flat.indexOf(term); idx >= 0; idx = flat.indexOf(term, idx + 1)) {
    let score = 1000 + (isBoundary(flat, idx) ? 200 : 0) - idx
    if (idx === 0 && term.length === flat.length) score += 500 // 整字段精确命中
    if (!best || score > best.score) {
      best = { score, positions: Array.from({ length: term.length }, (_, k) => idx + k) }
    }
  }
  if (best) return best
  // 2) 子序列：字符按序出现即可（跨分隔符也算），分数低
  const positions: number[] = []
  let i = 0
  for (let k = 0; k < flat.length && i < term.length; k++) {
    if (flat.charCodeAt(k) === term.charCodeAt(i)) { positions.push(k); i++ }
  }
  if (i < term.length) return null
  const gaps = positions[positions.length - 1] - positions[0] - (term.length - 1)
  const score = 400 + (isBoundary(flat, positions[0]) ? 100 : 0) - gaps * 8 - positions[0]
  return { score, positions }
}

function toRanges(indices: number[]): Range[] {
  const uniq = [...new Set(indices)].sort((a, b) => a - b)
  const ranges: Range[] = []
  for (const idx of uniq) {
    const last = ranges[ranges.length - 1]
    if (last && idx === last[1]) last[1] = idx + 1
    else ranges.push([idx, idx + 1])
  }
  return ranges
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

// 一个词命中一个字段：raw 与 pinyin 两条索引都试，取高分；命中位置回映成原字符区间。
function matchTermInField(term: string, hay: Hay): { score: number; ranges: Range[] } | null {
  const rawM = matchInFlat(term, hay.raw)
  let best = rawM ? { score: rawM.score, positions: rawM.positions, map: null as number[] | null } : null
  if (hay.pyFlat) {
    const pyM = matchInFlat(term, hay.pyFlat)
    // 拼音命中略降权，等分时优先直接命中
    if (pyM && (!best || pyM.score - 50 > best.score)) {
      best = { score: pyM.score - 50, positions: pyM.positions, map: hay.pyMap }
    }
  }
  if (!best) return null
  const orig = best.map ? best.positions.map((p) => best!.map![p]) : best.positions
  return { score: best.score, ranges: toRanges(orig) }
}

export interface FuzzyResult {
  score: number
  highlights: Range[][] // 与 fields 等长，每项是该字段的高亮区间
}

// query 命中 fields（任一词命中任一字段即为该词命中；所有词都命中才算整体命中）。
// weights 可给字段加权（如分组名 > 路径）。空 query → 命中且 score=0（调用方保持原序）。
export function fuzzySearch(query: string, fields: string[], weights?: number[]): FuzzyResult | null {
  const highlights: Range[][] = fields.map(() => [])
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { score: 0, highlights }
  const hays = fields.map(buildHay)
  let total = 0
  for (const term of terms) {
    let bestIdx = -1
    let bestScore = -Infinity
    let bestRanges: Range[] = []
    for (let fi = 0; fi < fields.length; fi++) {
      if (!fields[fi]) continue
      const m = matchTermInField(term, hays[fi])
      if (!m) continue
      const s = m.score * (weights?.[fi] ?? 1)
      if (s > bestScore) { bestScore = s; bestIdx = fi; bestRanges = m.ranges }
    }
    if (bestIdx < 0) return null // 有词一个字段都没命中 → 整体失败
    total += bestScore
    highlights[bestIdx] = mergeRanges([...highlights[bestIdx], ...bestRanges])
  }
  return { score: total, highlights }
}

// 兼容旧调用：只要不要分数/高亮的布尔判断。
export function fuzzyMatch(needle: string, haystacks: string | string[]): boolean {
  const list = Array.isArray(haystacks) ? haystacks : [haystacks]
  return fuzzySearch(needle, list) !== null
}

// 按区间把 text 包上 <mark class="hl">，其余转义。ranges 为原字符下标 [start,end)。
export function highlightRanges(text: string, ranges?: Range[]): string {
  if (!ranges || ranges.length === 0) return escapeHtml(text)
  const sorted = mergeRanges(ranges)
  let out = ''
  let pos = 0
  for (const [s, e] of sorted) {
    if (s > pos) out += escapeHtml(text.slice(pos, s))
    out += `<mark class="hl">${escapeHtml(text.slice(s, e))}</mark>`
    pos = e
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos))
  return out
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

// ─── 会话选择浮层 ────────────────────────────────────────────────
// 点「N 会话」徽标弹出的小列表。两个恢复入口共用：
//   · 管理页(入口②)：选一条 = 直接恢复标签页并以该会话为活跃会话；
//   · 勾选弹窗(入口①)：选一条 = 指定该标签用此会话恢复，selectedId 高亮已选，onClear 提供"用默认"。
// 锚定在被点击的徽标下方，越界自动上翻/内收；外部点击 / Esc / 滚动即关闭。
export interface SessPickEntry {
  sessionId: string
  title: string
  source: string
  ts?: string
  isDefault: boolean // 该标签默认活跃会话（不选就是它）
}
let sessPickHost: HTMLDivElement | null = null
let sessPickDetach: (() => void) | null = null
export function closeSessionPicker(): void {
  sessPickDetach?.()
  sessPickDetach = null
  sessPickHost?.remove()
  sessPickHost = null
}
export function openSessionPicker(opts: {
  anchor: HTMLElement
  entries: SessPickEntry[]
  selectedId?: string
  onPick: (sessionId: string) => void
  onClear?: () => void
  title?: string
}): void {
  closeSessionPicker()
  const host = document.createElement('div')
  host.className = 'sesspick'
  const head = opts.title ? `<div class="sesspick-head">${escapeHtml(opts.title)}</div>` : ''
  const clearRow = opts.onClear
    ? `<div class="sesspick-item sesspick-clear" data-sp-clear="1"><div class="sess-body"><div class="sess-title">用默认会话恢复</div><div class="sess-meta">清除指定，按标签原活跃会话</div></div></div>`
    : ''
  const rows = opts.entries
    .map((e) => {
      const sel = !!opts.selectedId && e.sessionId === opts.selectedId
      const meta = `${escapeHtml(formatTs(e.ts))} · <span class="src">${escapeHtml(srcLabel(e.source))}</span> · ${escapeHtml(e.sessionId.slice(0, 8))}${e.isDefault ? ' · <span class="cur">默认</span>' : ''}`
      return `<div class="sesspick-item sess-item${e.isDefault ? ' current' : ''}${sel ? ' selected' : ''}" data-sp-sid="${escapeHtml(e.sessionId)}">
      <span class="sdot"></span>
      <div class="sess-body">
        <div class="sess-title">${escapeHtml(e.title)}</div>
        <div class="sess-meta">${meta}</div>
      </div>
    </div>`
    })
    .join('')
  host.innerHTML = head + rows + clearRow
  document.body.appendChild(host)
  sessPickHost = host

  // 定位：锚点下方左对齐。上下空间都放不下时，选空间更大的一侧并把高度收进该侧可用高度，
  // 避免被顶到标题栏（top=8）盖住窗口控制按钮，变成贴顶的一整列。
  const r = opts.anchor.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const MARGIN = 8
  const GAP = 4
  const SAFE_TOP = 40 // 标题栏 32px + 余量：浮层不越过此线
  const spaceBelow = vh - r.bottom - GAP - MARGIN
  const spaceAbove = r.top - GAP - MARGIN - SAFE_TOP
  const placeBelow = spaceBelow >= spaceAbove
  // 把浮层最大高度限制在所选一侧的可用高度内（内部已有 overflow-y 滚动）
  const avail = Math.max(Math.floor(placeBelow ? spaceBelow : spaceAbove), 120)
  host.style.maxHeight = `${avail}px`
  const pw = host.offsetWidth
  const ph = host.offsetHeight
  let left = r.left
  if (left + pw > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - pw)
  let top = placeBelow ? r.bottom + GAP : r.top - GAP - ph
  top = Math.max(SAFE_TOP, top)
  host.style.left = `${Math.round(left)}px`
  host.style.top = `${Math.round(top)}px`

  host.addEventListener('click', (e) => {
    const clr = (e.target as HTMLElement).closest('[data-sp-clear]')
    if (clr) {
      const cb = opts.onClear
      closeSessionPicker()
      cb?.()
      return
    }
    const row = (e.target as HTMLElement).closest('[data-sp-sid]') as HTMLElement | null
    if (!row) return
    const sid = row.dataset.spSid!
    closeSessionPicker()
    opts.onPick(sid)
  })

  const onDocDown = (e: MouseEvent): void => {
    if (host.contains(e.target as Node) || opts.anchor.contains(e.target as Node)) return
    closeSessionPicker()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSessionPicker()
    }
  }
  const onGone = (): void => closeSessionPicker()
  // 滚动关闭仅针对浮层"外部"的滚动（底层列表滚动会让锚点移位）；
  // 在浮层自身内部滚动不该把它关掉。
  const onScroll = (e: Event): void => {
    if (host.contains(e.target as Node)) return
    closeSessionPicker()
  }
  // 延后挂 mousedown，避免"打开这一次点击"立即把它关掉
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onGone, true)
  window.addEventListener('scroll', onScroll, true)
  sessPickDetach = () => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onGone, true)
    window.removeEventListener('scroll', onScroll, true)
  }
}
