// 悬浮窗（小卡片，常驻顶层）：仅展示 done / attention / busy 计数；
// 全 0 时退回展示当前会话总数。计数由主窗口渲染层通过 IPC 'floater:push' 推过来。

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { saveSettings, loadSettings } from './settings'

let win: BrowserWindow | null = null
let lastCounts: { done: number; attention: number; busy: number; total: number } = {
  done: 0, attention: 0, busy: 0, total: 0
}

export function getFloaterWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

// 右键菜单时临时撑大窗口；菜单关闭再缩回。
// 只动 width/height，不动 x/y，让卡片相对屏幕的视觉位置保持不变。
export function resizeFloater(w: number, h: number): void {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  win.setBounds({
    x, y,
    width: Math.max(FLOATER_W, Math.floor(w) || FLOATER_W),
    height: Math.max(FLOATER_H, Math.floor(h) || FLOATER_H)
  })
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

export const FLOATER_W = 130
export const FLOATER_H = 34

function defaultPosition(): { x: number; y: number } {
  const disp = screen.getPrimaryDisplay()
  const wa = disp.workArea
  // 默认贴右上角，离边距 16px
  return { x: wa.x + wa.width - FLOATER_W - 16, y: wa.y + 16 }
}

// 当前 (x, y, w, h) 的矩形和任一显示器的 workArea 有像样的交叠就算"在屏内"。
// 阈值取 24px：拖到屏幕边缘只露一个角的不算，避免下次更难找回。
function rectVisible(x: number, y: number, w: number, h: number): boolean {
  const MIN_VIS = 24
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea
    const ix = Math.max(x, wa.x)
    const iy = Math.max(y, wa.y)
    const ax = Math.min(x + w, wa.x + wa.width)
    const ay = Math.min(y + h, wa.y + wa.height)
    if (ax - ix >= MIN_VIS && ay - iy >= MIN_VIS) return true
  }
  return false
}

// 用户语境：插了大屏把悬浮窗拖到大屏，关掉大屏后小屏看不到 —— 老坐标落在已经
// 不存在的 display 上。检测到不可见就挪回主屏右上角并落盘。
export function ensureFloaterOnScreen(): void {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  if (rectVisible(x, y, w, h)) return
  const pos = defaultPosition()
  win.setBounds({ x: pos.x, y: pos.y, width: FLOATER_W, height: FLOATER_H })
  try {
    const cur = loadSettings()
    saveSettings({ ...cur, floaterX: pos.x, floaterY: pos.y })
  } catch {}
}

export function createFloater(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  const s = loadSettings()
  // 启动前先校验：保存的位置如果落在已经断开的显示器上，直接回退到默认主屏右上角
  // null = 未持久化 → 默认位；有值就校验是否落在某块现存屏内（拔屏后老坐标会失效）
  const sx = s.floaterX, sy = s.floaterY
  const pos = (sx != null && sy != null && rectVisible(sx, sy, FLOATER_W, FLOATER_H))
    ? { x: sx, y: sy }
    : defaultPosition()
  win = new BrowserWindow({
    width: FLOATER_W,
    height: FLOATER_H,
    x: pos.x,
    y: pos.y,
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
    // 加载完成后立刻把上次的计数推一份过去（用户开关切换或重启都不丢初值）
    pushCountsToFloater()
  })

  // 崩溃自愈：悬浮窗是透明窗，渲染进程一旦非正常退出（GPU 重置 / 驱动抽风 / OOM），内容直接
  // 消失，窗口看着就"自己不见了"，以前只能去设置里关开关再打开（本质是重建）才回来。这里监听
  // 渲染进程退出，非 clean-exit 就自动 reload 把它救回来；重载后 did-finish-load 会重推计数。
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!win || win.isDestroyed() || details.reason === 'clean-exit') return
    try { win.webContents.reload() } catch {}
  })
  // 每次加载完成（含崩溃后 reload）都补推一份计数，避免救回来后是一张空卡片
  win.webContents.on('did-finish-load', () => pushCountsToFloater())

  // 拖动结束 / 关闭前把坐标落盘
  const persistPos = (): void => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const cur = loadSettings()
    if (cur.floaterX === x && cur.floaterY === y) return
    saveSettings({ ...cur, floaterX: x, floaterY: y })
  }
  win.on('moved', persistPos)
  win.on('close', persistPos)
  win.on('closed', () => {
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
