// 多窗口管理：副窗口创建（同一份 index.html?secondary=1）+ 跨窗口标签迁移协调。
// 迁移流水线：目标窗口就绪 → holdPty 暂存输出 → 源窗口 export（serialize + detach，
// 不杀 PTY）→ 目标窗口 import → flushPty 切路由并回放暂存队列。
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { killPty } from './pty-manager'
import {
  claimTab, releaseTab, tabOwnerWc, holdPty, flushPty, dropWc, wcHasTabs
} from './tab-router'

let getMainWindow: () => BrowserWindow | null = () => null
export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getMainWindow = fn
}

const secondaryWindows = new Set<BrowserWindow>()
// 副窗口渲染层 initApp 完成后上报 ready；迁移协调靠它知道何时可以 import
const secondaryReady = new Map<number, { promise: Promise<void>; resolve: () => void }>()

export function isSecondaryWindow(win: BrowserWindow): boolean {
  return secondaryWindows.has(win)
}

function readyGate(winId: number): Promise<void> {
  let entry = secondaryReady.get(winId)
  if (!entry) {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    entry = { promise, resolve }
    secondaryReady.set(winId, entry)
  }
  return entry.promise
}

export function createSecondaryWindow(at?: { x: number; y: number }): BrowserWindow {
  const isMac = process.platform === 'darwin'
  // 落点以鼠标松手处为基准，夹回工作区内
  let bounds: { x?: number; y?: number } = {}
  if (at) {
    const disp = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) })
    const wa = disp.workArea
    const w = 960
    const h = 640
    bounds = {
      x: Math.min(Math.max(wa.x, Math.round(at.x) - 80), wa.x + wa.width - w),
      y: Math.min(Math.max(wa.y, Math.round(at.y) - 20), wa.y + wa.height - h)
    }
  }
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    ...bounds,
    show: false,
    backgroundColor: '#ffffff',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  secondaryWindows.add(win)

  const sendState = (maximized: boolean): void => {
    if (win.isDestroyed()) return
    try { win.webContents.send('window:state', { maximized }) } catch {}
  }
  win.on('maximize', () => sendState(true))
  win.on('unmaximize', () => sendState(false))

  // 副窗口关闭：还有标签 → 渲染层弹确认（复用 close-request 流程）；空了 → 静默放行
  win.on('close', (e) => {
    if (win.isDestroyed()) return
    if (!wcHasTabs(win.webContents)) return
    e.preventDefault()
    try { win.webContents.send('window:close-request') } catch {}
  })

  win.on('ready-to-show', () => { if (!win.isDestroyed()) win.show() })

  win.on('closed', () => {
    secondaryWindows.delete(win)
    secondaryReady.delete(win.id)
  })

  // 渲染进程销毁：清路由表 + 杀名下 PTY，不留孤儿 pwsh
  win.webContents.on('destroyed', () => {
    for (const ptyId of dropWc(win.webContents)) {
      try { killPty(ptyId) } catch {}
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '?secondary=1')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { secondary: '1' } })
  }
  return win
}

interface MovePayloadBase {
  tabId: string
  // 有值 = 迁到该窗口（拖回/跨窗）；无值 = 拖出成新窗
  targetWindowId?: number
  screenX?: number
  screenY?: number
}

// 迁移中的 tab 集合：挡住迁移期间的二次拖动
const migrating = new Set<string>()

let exportSeq = 0

// 向源窗口请求导出：send + 一次性 reply channel（渲染层 serialize 后回包）
function requestExport(wc: Electron.WebContents, tabId: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const reqId = `${Date.now()}_${exportSeq++}`
    const replyCh = `tab:export-reply:${reqId}`
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(replyCh)
      resolve(null)
    }, 8000)
    ipcMain.once(replyCh, (_e, payload: Record<string, unknown> | null) => {
      clearTimeout(timer)
      resolve(payload)
    })
    try {
      wc.send('tab:export-request', { reqId, tabId })
    } catch {
      clearTimeout(timer)
      ipcMain.removeAllListeners(replyCh)
      resolve(null)
    }
  })
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:id', (e) => BrowserWindow.fromWebContents(e.sender)?.id ?? -1)

  ipcMain.on('window:secondary-ready', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    readyGate(win.id) // 确保 entry 存在
    secondaryReady.get(win.id)?.resolve()
  })

  ipcMain.on('tab:claim', (e, tabId: string) => {
    if (typeof tabId !== 'string' || !tabId) return
    claimTab(tabId, e.sender)
  })
  ipcMain.on('tab:release', (_e, tabId: string) => {
    if (typeof tabId !== 'string' || !tabId) return
    releaseTab(tabId)
  })

  // 源窗口 export 前调：让该 PTY 的输出进入暂存队列（invoke 确保 hold 先于 serialize）
  ipcMain.handle('pty:hold', (_e, ptyId: number) => {
    if (typeof ptyId === 'number' && Number.isFinite(ptyId)) holdPty(ptyId)
  })

  // 迁移主流程。返回 { ok, error? }
  ipcMain.handle('tab:moveToWindow', async (e, raw: MovePayloadBase) => {
    const tabId = typeof raw?.tabId === 'string' ? raw.tabId : ''
    if (!tabId) return { ok: false, error: 'bad tabId' }
    if (migrating.has(tabId)) return { ok: false, error: 'migrating' }

    const srcWc = tabOwnerWc(tabId) ?? getMainWindow()?.webContents ?? null
    if (!srcWc || srcWc.isDestroyed()) return { ok: false, error: 'source gone' }

    // 拖出成新窗时：松手点落在本 app 现有窗口内 = 拖到窗口空白处，不误开新窗
    let targetWin: BrowserWindow | null = null
    if (raw?.targetWindowId != null) {
      targetWin = BrowserWindow.getAllWindows().find((w) => w.id === raw.targetWindowId) ?? null
      if (!targetWin || targetWin.isDestroyed()) return { ok: false, error: 'target gone' }
      if (targetWin.webContents === srcWc) return { ok: false, error: 'same window' }
    } else {
      const px = Number(raw?.screenX)
      const py = Number(raw?.screenY)
      if (Number.isFinite(px) && Number.isFinite(py)) {
        const hit = BrowserWindow.getAllWindows().some((w) => {
          if (w.isDestroyed() || !w.isVisible()) return false
          const b = w.getBounds()
          return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height
        })
        if (hit) return { ok: false, error: 'inside window' }
      }
    }

    migrating.add(tabId)
    try {
      if (!targetWin) {
        targetWin = createSecondaryWindow(
          Number.isFinite(Number(raw?.screenX))
            ? { x: Number(raw.screenX), y: Number(raw.screenY) }
            : undefined
        )
        // 等副窗口渲染层就绪（15s 兜底：dev 首次编译可能慢）
        await Promise.race([
          readyGate(targetWin.id),
          new Promise<void>((r) => setTimeout(r, 15000))
        ])
        if (targetWin.isDestroyed()) return { ok: false, error: 'target gone' }
      }

      // 源窗口导出（渲染层先 invoke pty:hold 再 serialize，保证不丢字节）
      const payload = await requestExport(srcWc, tabId)
      if (!payload) return { ok: false, error: 'export failed' }

      releaseTab(tabId)
      const targetWc = targetWin.webContents
      if (targetWc.isDestroyed()) {
        // 目标没了且源已 detach，只能杀 PTY 避免悬挂
        const ptyId = payload.ptyId
        if (typeof ptyId === 'number') { try { killPty(ptyId) } catch {} }
        return { ok: false, error: 'target gone' }
      }
      try { targetWc.send('tab:import', payload) } catch {
        return { ok: false, error: 'import send failed' }
      }
      // 副窗口最后一个标签迁走 → 自动关窗。必须在主进程此处做：export 回包已收到、
      // releaseTab 已执行，时序才安全。
      const srcWin = BrowserWindow.fromWebContents(srcWc)
      if (srcWin && !srcWin.isDestroyed() && isSecondaryWindow(srcWin) && !wcHasTabs(srcWc)) {
        try { srcWin.destroy() } catch {}
      }
      // import 完成由目标窗口回 'tab:import-done'，这里不等待
      return { ok: true }
    } finally {
      migrating.delete(tabId)
    }
  })

  // 目标窗口 import 完成：认领 tab + 把 PTY 路由切过来并回放暂存队列
  ipcMain.on('tab:import-done', (e, info: { tabId: string; ptyId: number | null }) => {
    if (typeof info?.tabId === 'string' && info.tabId) claimTab(info.tabId, e.sender)
    if (typeof info?.ptyId === 'number') {
      flushPty(info.ptyId, e.sender)
    }
  })
}

// 主窗口以外的所有副窗口（广播用）
export function allAppWebContents(): Electron.WebContents[] {
  const out: Electron.WebContents[] = []
  const main = getMainWindow()
  if (main && !main.isDestroyed()) out.push(main.webContents)
  for (const w of secondaryWindows) {
    if (!w.isDestroyed()) out.push(w.webContents)
  }
  return out
}

export function destroyAllSecondary(): void {
  for (const w of [...secondaryWindows]) {
    try { w.destroy() } catch {}
  }
  secondaryWindows.clear()
}
