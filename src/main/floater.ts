// 悬浮窗（重写版）：小胶囊常驻顶层，展示 done / attention / busy 计数；
// 计数由主窗口渲染层通过 IPC 'floater:push' 推过来。
//
// 架构：窗口一次性建成"菜单包络"大小（胶囊四周预留右键菜单的活动空间），
// 胶囊固定绘制在窗口中央偏移处；透明区域用 setIgnoreMouseEvents(forward:true)
// 做鼠标穿透，悬到胶囊/菜单上时由渲染层通过 IPC 收回鼠标。
// 这样右键菜单直接在窗口内展开，不需要任何动态 setBounds ——
// 旧实现"右键时撑大窗口再缩回"在 Windows 非 100% 缩放下会因 DIP↔物理像素
// 换算 bug 导致窗口和胶囊对不上、菜单弹出也一顿一顿。

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { saveSettings, loadSettings } from './settings'

// 胶囊尺寸 + 它在窗口内的固定偏移（与 floater.html 里的 .card 定位保持一致）。
// 四周留白就是右键菜单的活动空间：菜单 ~170×90，两个方向都留 ≥200/130，
// 在胶囊任意位置右键、向任意方向翻转都放得下。
export const PILL_W = 130
export const PILL_H = 34
export const PILL_OFF_X = 200
export const PILL_OFF_Y = 130
const WIN_W = PILL_W + PILL_OFF_X * 2
const WIN_H = PILL_H + PILL_OFF_Y * 2

let win: BrowserWindow | null = null
let lastCounts: { done: number; attention: number; busy: number; total: number } = {
  done: 0, attention: 0, busy: 0, total: 0
}

export function getFloaterWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

// 持久化语义不变：settings.floaterX/Y 存的是"胶囊"的屏幕坐标（窗口坐标 = 胶囊 - 偏移）。
function pillPosition(): { x: number; y: number } | null {
  if (!win || win.isDestroyed()) return null
  const [wx, wy] = win.getPosition()
  return { x: wx + PILL_OFF_X, y: wy + PILL_OFF_Y }
}

function defaultPillPosition(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  // 默认贴右上角，离边距 16px
  return { x: wa.x + wa.width - PILL_W - 16, y: wa.y + 16 }
}

// 胶囊矩形和任一显示器的 workArea 有像样的交叠就算"在屏内"。
// 阈值取 24px：拖到屏幕边缘只露一个角的不算，避免下次更难找回。
function pillVisible(x: number, y: number): boolean {
  const MIN_VIS = 24
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea
    const ix = Math.max(x, wa.x)
    const iy = Math.max(y, wa.y)
    const ax = Math.min(x + PILL_W, wa.x + wa.width)
    const ay = Math.min(y + PILL_H, wa.y + wa.height)
    if (ax - ix >= MIN_VIS && ay - iy >= MIN_VIS) return true
  }
  return false
}

function moveWindowToPill(x: number, y: number): void {
  if (!win || win.isDestroyed()) return
  // 只挪位置、绝不碰尺寸：尺寸在创建时定死。透明窗口在 Windows 上切 resizable /
  // 改 size 都可能触发渲染丢失（透明 + resizable 是 Electron 已知雷区），
  // 而 setPosition 不涉及 DIP 尺寸换算，缩放 ≠ 100% 也安全。
  win.setPosition(x - PILL_OFF_X, y - PILL_OFF_Y)
}

// 用户语境：插了大屏把悬浮窗拖到大屏，关掉大屏后小屏看不到 —— 老坐标落在已经
// 不存在的 display 上。检测到不可见就挪回主屏右上角并落盘。
export function ensureFloaterOnScreen(): void {
  const pos = pillPosition()
  if (!pos) return
  if (pillVisible(pos.x, pos.y)) return
  const def = defaultPillPosition()
  moveWindowToPill(def.x, def.y)
  try {
    const cur = loadSettings()
    saveSettings({ ...cur, floaterX: def.x, floaterY: def.y })
  } catch {}
}

// 鼠标穿透管理：主进程轮询光标位置。
// 不能靠渲染层 mousemove —— 胶囊是 -webkit-app-region:drag 区域，drag 区域的
// 鼠标事件（含穿透转发的 mousemove）不会派发给页面，渲染层根本感知不到悬停。
// 规则：光标在胶囊上（±4px 容差）或菜单开着（focusable=true 即菜单态）→ 接管鼠标；
// 否则整窗穿透。原生拖动时窗口跟着光标走、相对位置不变，不会中途误切穿透。
let ignoring = true
let hoverTimer: ReturnType<typeof setInterval> | null = null

function pollHover(): void {
  if (!win || win.isDestroyed()) return
  const pt = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  const px = wx + PILL_OFF_X
  const py = wy + PILL_OFF_Y
  const overPill =
    pt.x >= px - 4 && pt.x <= px + PILL_W + 4 &&
    pt.y >= py - 4 && pt.y <= py + PILL_H + 4
  const menuOpen = win.isFocusable()
  const wantIgnore = !overPill && !menuOpen
  if (wantIgnore === ignoring) return
  ignoring = wantIgnore
  win.setIgnoreMouseEvents(wantIgnore, { forward: true })
}

// 菜单打开时把悬浮窗临时设为可聚焦并 focus —— 拿到 blur 事件用来检测
// "点了悬浮窗外面"，关菜单时再切回 focusable:false 不抢主窗口的焦点。
export function setFloaterFocusable(focus: boolean): void {
  if (!win || win.isDestroyed()) return
  win.setFocusable(focus)
  if (focus) {
    try { win.focus() } catch {}
  }
}

export function createFloater(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    return
  }
  const s = loadSettings()
  // null = 未持久化 → 默认位；有值就校验是否落在某块现存屏内（拔屏后老坐标会失效）
  const sx = s.floaterX, sy = s.floaterY
  const pill = (sx != null && sy != null && pillVisible(sx, sy))
    ? { x: sx, y: sy }
    : defaultPillPosition()
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pill.x - PILL_OFF_X,
    y: pill.y - PILL_OFF_Y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // 真正贴顶：覆盖在全屏视频 / 其他全屏应用之上也仍可见
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 初始整窗穿透；悬停接管由主进程 pollHover 驱动
  win.setIgnoreMouseEvents(true, { forward: true })
  ignoring = true
  hoverTimer = setInterval(pollHover, 80)
  // 拦掉 Windows 在 -webkit-app-region:drag 区域右键弹出的系统菜单（还原/移动/大小/关闭…），
  // 让渲染层的 contextmenu 事件能正常触发，弹我们自己的 UI 一致菜单。
  win.on('system-context-menu', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/floater.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/floater.html'))
  }

  win.on('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    win.showInactive()
    pushCountsToFloater()
  })

  // 崩溃自愈：渲染进程非正常退出（GPU 重置 / 驱动抽风 / OOM）时透明窗内容直接消失，
  // 监听到就自动 reload 救回来；重载后 did-finish-load 会重推计数。
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!win || win.isDestroyed() || details.reason === 'clean-exit') return
    try { win.webContents.reload() } catch {}
  })
  // 每次加载完成（含崩溃后 reload）都补推计数 + 重置穿透态，避免救回来后鼠标状态错乱
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) {
      ignoring = true
      win.setIgnoreMouseEvents(true, { forward: true })
    }
    pushCountsToFloater()
  })

  // 拖动结束 / 关闭前把"胶囊"坐标落盘
  const persistPos = (): void => {
    const pos = pillPosition()
    if (!pos) return
    const cur = loadSettings()
    if (cur.floaterX === pos.x && cur.floaterY === pos.y) return
    saveSettings({ ...cur, floaterX: pos.x, floaterY: pos.y })
  }
  win.on('moved', persistPos)
  win.on('close', persistPos)
  win.on('closed', () => {
    if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null }
    screen.off('display-removed', ensureFloaterOnScreen)
    screen.off('display-metrics-changed', ensureFloaterOnScreen)
    win = null
  })
  // 监听显示器变化：拔屏 / 分辨率 / 缩放 / workArea 变了都来挪一次窗
  screen.on('display-removed', ensureFloaterOnScreen)
  screen.on('display-metrics-changed', ensureFloaterOnScreen)
}

export function destroyFloater(): void {
  if (!win || win.isDestroyed()) { win = null; return }
  win.close()
  win = null
}

export function setFloaterEnabled(on: boolean): void {
  if (on) createFloater()
  else destroyFloater()
}

export function pushCountsToFloater(counts?: typeof lastCounts): void {
  if (counts) lastCounts = counts
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.send('floater:counts', lastCounts) } catch {}
}
