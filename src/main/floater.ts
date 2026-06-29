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

export const FLOATER_W = 140
export const FLOATER_H = 44

function defaultPosition(): { x: number; y: number } {
  const disp = screen.getPrimaryDisplay()
  const wa = disp.workArea
  // 默认贴右上角，离边距 16px
  return { x: wa.x + wa.width - FLOATER_W - 16, y: wa.y + 16 }
}

export function createFloater(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  const s = loadSettings()
  const pos = (s.floaterX >= 0 && s.floaterY >= 0)
    ? { x: s.floaterX, y: s.floaterY }
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
  win.on('closed', () => { win = null })
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
