// 悬浮窗渲染入口（重写版）：订阅主进程推送的计数 → 渲染胶囊；
// 窗口是"菜单包络"大小的透明窗，胶囊固定在中央偏移处（见 floater.html .card）。
// 鼠标穿透由主进程轮询光标位置管理（胶囊是 app-region:drag，页面收不到它上面的
// 鼠标事件，渲染层做不了悬停检测）；这里只负责画胶囊和右键菜单。
// 右键菜单直接在窗口内展开，零窗口 resize。
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

const MENU_PAD = 8

let menuOpen = false

// ─── 右键菜单（UI 与主窗口 .ctx 同款） ───────────────────────────────
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

function openCtx(items: CtxItem[], x: number, y: number): void {
  buildCtx(items)
  menuOpen = true
  ctxEl.classList.add('open')
  // 量一下实际尺寸，再决定往哪边展开
  ctxEl.style.left = '-9999px'
  ctxEl.style.top = '0px'
  const w = ctxEl.offsetWidth
  const h = ctxEl.offsetHeight
  // 窗口可能有一截伸出屏幕外（胶囊贴屏幕边缘时），翻转判断要用"屏幕剩余空间"，
  // 不能只看窗口内坐标 —— 否则菜单会展开到屏幕外的窗口区域里。
  const sx = window.screenX + x
  const sy = window.screenY + y
  const scr = window.screen
  const availL = scr.availLeft ?? 0
  const availT = scr.availTop ?? 0
  let px = sx + w + MENU_PAD <= availL + scr.availWidth ? x : x - w
  let py = sy + h + MENU_PAD <= availT + scr.availHeight ? y : y - h
  // 兜底夹回窗口内
  px = Math.min(Math.max(0, px), window.innerWidth - w - 2)
  py = Math.min(Math.max(0, py), window.innerHeight - h - 2)
  ctxEl.style.left = `${px}px`
  ctxEl.style.top = `${py}px`
  // 菜单打开期间让卡片不抢拖动事件，确保 mousedown 能派发到 renderer 关菜单
  cardEl?.classList.add('menu-open')
  // 临时变成可聚焦并 focus：blur 监听用来捕捉"点了悬浮窗外面"；
  // 同时 focusable=true 也是主进程侧"菜单开着，别切穿透"的信号
  window.term?.floaterSetFocusable?.(true)
}

function closeCtx(): void {
  if (!menuOpen) return
  menuOpen = false
  ctxEl.classList.remove('open')
  cardEl?.classList.remove('menu-open')
  window.term?.floaterSetFocusable?.(false)
}

// 关闭路径：
// 1. 左键点到菜单以外（胶囊上）—— 走 mousedown 监听
// 2. 点到悬浮窗外面（其他 app / 桌面）—— 走 window blur
// 3. Esc 键
// 右键不在 mousedown 里关（交给 contextmenu 的 toggle 语义处理）。
document.addEventListener('mousedown', (e) => {
  if (e.button === 2) return
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

// 穿透态下右键会被 OS 接走，能触发到这里的 contextmenu 必然发生在胶囊/菜单上
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  // 已经开着 → 再次右键当作关闭（toggle），不要在新位置重开导致闪烁
  if (menuOpen) {
    closeCtx()
    return
  }
  openCtx(
    [
      { label: '打开主窗口', icon: ICON_OPEN, act: () => window.term?.floaterFocusMain?.() },
      { sep: true },
      { label: '隐藏悬浮窗', icon: ICON_EYE_OFF, danger: true, act: () => window.term?.floaterHide?.() }
    ],
    e.clientX,
    e.clientY
  )
})

// ─── 计数渲染 ─────────────────────────────────────────────────────
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
