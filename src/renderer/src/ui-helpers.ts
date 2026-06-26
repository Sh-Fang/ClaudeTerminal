// 简单 UI 工具：context menu / modal / toast / confirm

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
  act?: () => void
}

export function showCtxMenu(items: CtxItem[], x: number, y: number): void {
  ctxEl.innerHTML = ''
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div')
      s.className = 'ctx-sep'
      ctxEl.appendChild(s)
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
  ctxEl.classList.remove('open')
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
  scrim.hidden = false
  setTimeout(() => {
    modalName.focus()
    modalName.select()
  }, 0)
}

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
      if (picked) modalCwd.value = picked
    })
    .catch(() => {})
    .finally(() => {
      modalCwdPick.disabled = false
    })
})

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
