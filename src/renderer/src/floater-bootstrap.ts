// 悬浮窗渲染入口：订阅主进程推送的计数 → 渲染。
// 复用主窗口同款 preload，所以 window.term 是可用的。
// 这里手抄一份 FloaterCounts 结构，避免跨 tsconfig 直接 import preload。
interface FloaterCounts {
  done: number
  attention: number
  busy: number
  total: number
}

const itemsEl = document.getElementById('items') as HTMLDivElement
const ctxEl = document.getElementById('ctx') as HTMLDivElement
const cardEl = document.querySelector('.card') as HTMLDivElement

interface CtxItem { label?: string; icon?: string; danger?: boolean; sep?: boolean; act?: () => void }

const FLOATER_W = 130
const FLOATER_H = 34
const MENU_PAD = 6

function buildCtx(items: CtxItem[]): void {
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
    const ic = `<span class="ic">${it.icon ?? ''}</span>`
    const label = it.label ?? ''
    el.innerHTML = `${ic}<span>${label}</span>`
    el.addEventListener('click', () => { closeCtx(); it.act?.() })
    ctxEl.appendChild(el)
  }
}

function showCtx(items: CtxItem[], x: number, y: number): void {
  buildCtx(items)
  ctxEl.classList.add('open')
  // 先放到不可见处量一下尺寸，再决定窗口要撑多大
  ctxEl.style.left = '-9999px'
  ctxEl.style.top = '0px'
  const w = ctxEl.offsetWidth
  const h = ctxEl.offsetHeight
  // 用户语义：鼠标点击处 = 菜单左上角；窗口必须装下菜单
  const desiredW = Math.max(FLOATER_W, x + w + MENU_PAD)
  const desiredH = Math.max(FLOATER_H, y + h + MENU_PAD)
  window.term?.floaterResize?.(desiredW, desiredH)
  // 菜单打开期间让卡片不抢拖动事件，确保 mousedown 能派发到 renderer 关菜单
  cardEl?.classList.add('menu-open')
  // 临时变成可聚焦并 focus，下面 blur 监听就能捕捉到"点了悬浮窗外面"
  window.term?.floaterSetFocusable?.(true)
  // 等一帧 OS / Chromium 把新尺寸刷上，再把菜单贴到 (x, y)
  requestAnimationFrame(() => {
    ctxEl.style.left = `${x}px`
    ctxEl.style.top = `${y}px`
  })
}
function closeCtx(): void {
  if (!ctxEl.classList.contains('open')) return
  ctxEl.classList.remove('open')
  cardEl?.classList.remove('menu-open')
  window.term?.floaterSetFocusable?.(false)
  window.term?.floaterResize?.(FLOATER_W, FLOATER_H)
}
// 关闭路径：
// 1. 点到菜单以外（卡片上）—— 走 mousedown 监听
// 2. 点到悬浮窗外面（其他 app / 桌面）—— 走 window blur
// 3. Esc 键
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('#ctx')) closeCtx()
})
window.addEventListener('blur', () => closeCtx())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtx()
})

const ICON_OPEN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>'
const ICON_EYE_OFF =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.79 19.79 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.78 19.78 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'

window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  // 已经开着 → 再次右键当作关闭（toggle），不要在新位置重开导致闪烁
  if (ctxEl.classList.contains('open')) {
    closeCtx()
    return
  }
  showCtx(
    [
      { label: '打开主窗口', icon: ICON_OPEN, act: () => window.term?.floaterFocusMain?.() },
      { sep: true },
      { label: '隐藏悬浮窗', icon: ICON_EYE_OFF, danger: true, act: () => window.term?.floaterHide?.() }
    ],
    e.clientX,
    e.clientY
  )
})

function render(c: FloaterCounts): void {
  // 顺序：黄(待决策) → 蓝(运行中) → 绿(待查看)。三块常驻不隐藏 0，
  // 中间用竖条分隔。固定三列让数字位置稳定，扫一眼就能定位。
  itemsEl.innerHTML = [
    seg('attention', c.attention),
    seg('busy', c.busy),
    seg('done', c.done)
  ].join('<span class="sep"></span>')
}

function seg(kind: 'done' | 'attention' | 'busy', n: number): string {
  return `<span class="item"><span class="dot ${kind}"></span><span class="num">${n}</span></span>`
}

window.term?.onFloaterCounts?.(render)
render({ done: 0, attention: 0, busy: 0, total: 0 })
