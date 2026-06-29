import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { registerPtyIpc } from './ipc'
import { killAll } from './pty-manager'
import { ensureHookAssets } from './hook-assets'
import { SessionEventWatcher } from './session-events'
import { StateEventWatcher } from './state-events'
import { isSafeExternalUrl } from './url-safety'
import { setFloaterEnabled, destroyFloater } from './floater'
import { loadSettings } from './settings'

let mainWindow: BrowserWindow | null = null
let allowClose = false

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    backgroundColor: '#ffffff',
    frame: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const sendState = (maximized: boolean): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const wc = mainWindow.webContents
    if (!wc || wc.isDestroyed()) return
    try { wc.send('window:state', { maximized }) } catch {}
  }
  mainWindow.on('maximize', () => sendState(true))
  mainWindow.on('unmaximize', () => sendState(false))

  mainWindow.on('close', (e) => {
    if (allowClose) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    e.preventDefault()
    const wc = mainWindow.webContents
    if (!wc || wc.isDestroyed()) {
      allowClose = true
      mainWindow.close()
      return
    }
    try { wc.send('window:close-request') } catch {
      allowClose = true
      mainWindow.close()
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 主窗口一旦被销毁就把悬浮窗也带走 —— 悬浮窗 skipTaskbar，留着会卡住 window-all-closed
  mainWindow.on('closed', () => { destroyFloater() })

  // 终端输出里的链接（xterm web-links 等）触发 window.open 时，只放行 http(s)，
  // 挡掉 file: / 自定义协议等可被恶意内容利用的 scheme。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁止应用自身被导航走（始终停留在打包的 index.html / dev server）。
  // 外部链接应走上面的 openExternal，而不是替换掉渲染进程页面。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = process.env['ELECTRON_RENDERER_URL']
    if (allowed && url.startsWith(allowed)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let sessionWatcher: SessionEventWatcher | null = null
let stateWatcher: StateEventWatcher | null = null

function stopWatchers(): void {
  sessionWatcher?.stop(); sessionWatcher = null
  stateWatcher?.stop(); stateWatcher = null
}

app.whenReady().then(() => {
  registerPtyIpc(() => mainWindow)
  ipcMain.on('window:closeConfirmed', () => {
    allowClose = true
    // 先关掉悬浮窗，否则它还活着会卡住 window-all-closed，app 退不出去
    destroyFloater()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })
  const hp = ensureHookAssets()
  sessionWatcher = new SessionEventWatcher(hp.eventsDir, () => mainWindow)
  stateWatcher = new StateEventWatcher(hp.stateDir, () => mainWindow)
  sessionWatcher.start()
  stateWatcher.start()
  createWindow()
  // 启动时按设置决定是否拉起悬浮窗
  try {
    if (loadSettings().showFloater) setFloaterEnabled(true)
  } catch {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatchers()
  destroyFloater()
  killAll()
  // 用 app.exit 而非 app.quit：node-pty 的 conoutSocketWorker.dispose() 会挂一个
  // FLUSH_DATA_INTERVAL=1000ms 的 setTimeout 等最后一段输出 flush 再关 worker，
  // app.quit 是优雅退，会等事件循环排空 → 进程多挂 1s 才消失。
  // 窗口已关、renderer 已退、子进程同步 kill 完了，那 1s flush 没人在读，直接跳过。
  if (process.platform !== 'darwin') app.exit(0)
})

app.on('before-quit', () => {
  // 走 app.exit 时不会触发这里；保留是兜底 —— 例如 second-instance 路径或外部 app.quit()
  // 时仍能把 watcher/pty 清干净（重复调用 stopWatchers/killAll 是幂等的）。
  stopWatchers()
  killAll()
})
