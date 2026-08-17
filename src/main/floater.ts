// 悬浮窗：小胶囊常驻顶层展示 done/attention/busy 计数（渲染层经 IPC 推送）。
// 窗口一次性建成"菜单包络"大小、胶囊固定居中偏移，透明区域鼠标穿透；
// 不做动态 setBounds——Windows 非 100% 缩放下 DIP↔物理像素换算会导致错位。

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { saveSettings, loadSettings } from './settings'
import { mainWindow } from './windows'

// 胶囊尺寸与窗口内固定偏移（与 floater.html 的 .card 定位一致）；四周留白容纳右键菜单
export const PILL_W = 130
export const PILL_H = 34
export const PILL_OFF_X = 200
export const PILL_OFF_Y = 130
const WIN_W = PILL_W + PILL_OFF_X * 2
const WIN_H = PILL_H + PILL_OFF_Y * 2

let win: BrowserWindow | null = null
// destroyFloater 主动拆窗时置位，用于在 closed 里区分「计划内关闭」(关开关/App 退出) 与
// 「崩溃自灭」：只有后者才把 showFloater 同步成 false——若计划内关闭也写 false，App 正常
// 退出会把设置存成 false，下次启动悬浮窗就不出来了（回归）。
let intentionalClose = false
let lastCounts: { done: number; attention: number; busy: number; total: number } = {
  done: 0, attention: 0, busy: 0, total: 0
}

// 悬浮窗意外消失（崩溃/被系统关掉）时把设置翻成 off：与右键「隐藏」(ipc floater:hide) 同款
// 同步——落盘 showFloater=false + 给主渲染层发 floater:hidden，让内存 settings 与设置开关 UI
// 一起变 off，避免开关一直显示「开启」而实际已无窗。
function syncFloaterOffToSettings(): void {
  try {
    const cur = loadSettings()
    if (cur.showFloater) saveSettings({ ...cur, showFloater: false })
  } catch {}
  const mw = mainWindow()
  if (!mw || mw.isDestroyed()) return
  const wc = mw.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.send('floater:hidden') } catch {}
}

export function getFloaterWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

// settings.floaterX/Y 存的是"胶囊"的屏幕坐标（窗口坐标 = 胶囊 - 偏移）
function pillPosition(): { x: number; y: number } | null {
  if (!win || win.isDestroyed()) return null
  const [wx, wy] = win.getPosition()
  return { x: wx + PILL_OFF_X, y: wy + PILL_OFF_Y }
}

function defaultPillPosition(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - PILL_W - 16, y: wa.y + 16 }
}

// 胶囊与任一显示器 workArea 交叠 ≥24px 才算"在屏内"
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
  // 只挪位置不碰尺寸：Windows 上透明窗口改 size/resizable 可能渲染丢失（Electron 已知雷区）
  win.setPosition(x - PILL_OFF_X, y - PILL_OFF_Y)
}

// 老坐标可能落在已拔掉的显示器上：检测到不可见就挪回主屏右上角并落盘
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

// 鼠标穿透：主进程轮询光标位置（穿透态下渲染层收不到 mousemove）。
// 光标在胶囊上 / 菜单开着 / 拖动中 → 接管鼠标；否则整窗穿透。
let ignoring = true
let hoverTimer: ReturnType<typeof setInterval> | null = null
let draggingByUser = false

function pollHover(): void {
  if (!win || win.isDestroyed()) return
  // 拖动中窗口位置滞后于光标，按位置判断会误切穿透 —— 挂起轮询
  if (draggingByUser) return
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

// 渲染层拖动时推目标坐标；程序化 setPosition 不受 OS 拖动钳制，胶囊可贴屏幕最顶
export function moveFloaterTo(x: number, y: number): void {
  if (!win || win.isDestroyed()) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  win.setPosition(Math.round(x), Math.round(y))
}

export function setFloaterDragging(on: boolean): void {
  draggingByUser = on
  if (!win || win.isDestroyed()) return
  if (on && ignoring) {
    ignoring = false
    win.setIgnoreMouseEvents(false, { forward: true })
  }
  // 拖动结束落盘胶囊坐标（'moved' 对程序化移动不一定触发，这里兜底）
  if (!on) persistPillPos()
}

function persistPillPos(): void {
  const pos = pillPosition()
  if (!pos) return
  try {
    const cur = loadSettings()
    if (cur.floaterX === pos.x && cur.floaterY === pos.y) return
    saveSettings({ ...cur, floaterX: pos.x, floaterY: pos.y })
  } catch {}
}

// 菜单打开时临时可聚焦（靠 blur 检测点击外部），关菜单切回 focusable:false 不抢主窗口焦点
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
  // 未持久化 → 默认位；有值需校验仍落在现存屏内
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
  // 覆盖在全屏应用之上仍可见
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 初始整窗穿透；悬停接管由 pollHover 驱动
  win.setIgnoreMouseEvents(true, { forward: true })
  ignoring = true
  hoverTimer = setInterval(pollHover, 80)
  // 拦掉 Windows 在 drag 区域右键弹出的系统菜单，让渲染层 contextmenu 正常触发
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

  // 崩溃自愈：渲染进程非正常退出时透明窗内容会消失，自动 reload 救回
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!win || win.isDestroyed() || details.reason === 'clean-exit') return
    try { win.webContents.reload() } catch {}
  })
  // 每次加载完成（含 reload）补推计数 + 重置穿透态
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) {
      ignoring = true
      win.setIgnoreMouseEvents(true, { forward: true })
    }
    pushCountsToFloater()
  })

  // 移动 / 关闭前落盘胶囊坐标
  win.on('moved', persistPillPos)
  win.on('close', persistPillPos)
  win.on('closed', () => {
    if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null }
    screen.off('display-removed', ensureFloaterOnScreen)
    screen.off('display-metrics-changed', ensureFloaterOnScreen)
    win = null
    // 非计划内关闭（崩溃自灭）→ 设置与实际已不一致，同步成 off；计划内拆窗(destroyFloater)跳过
    const crashed = !intentionalClose
    intentionalClose = false
    if (crashed) syncFloaterOffToSettings()
  })
  // 显示器变化（拔屏/分辨率/缩放）时校正窗口位置
  screen.on('display-removed', ensureFloaterOnScreen)
  screen.on('display-metrics-changed', ensureFloaterOnScreen)
}

export function destroyFloater(): void {
  if (!win || win.isDestroyed()) { win = null; return }
  // 计划内拆窗：置位让 closed 别把 showFloater 同步成 false
  intentionalClose = true
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
