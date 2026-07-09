import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import { registerPtyIpc } from './ipc'
import { killAll } from './pty-manager'
import { ensureHookAssets } from './hook-assets'
import { SessionEventWatcher } from './session-events'
import { StateEventWatcher } from './state-events'
import { isSafeExternalUrl } from './url-safety'
import { setFloaterEnabled, destroyFloater } from './floater'
import { loadSettings } from './settings'
import { logEvent, startLogging, stopLogging } from './app-log'

let mainWindow: BrowserWindow | null = null
let allowClose = false

// 未捕获错误：越早注册越好，不用等 ready；startLogging 之前落的会因文件未开而丢，
// 但保底能进 electron 内置 stderr。startLogging 之后的都会 JSONL 落盘。
process.on('uncaughtException', (err) => {
  try { logEvent('uncaught_exception', { message: err.message, stack: err.stack }) } catch {}
})
process.on('unhandledRejection', (reason) => {
  const r = reason as { message?: string; stack?: string } | string | undefined
  try {
    logEvent('unhandled_rejection', {
      message: typeof r === 'string' ? r : r?.message,
      stack: typeof r === 'object' ? r?.stack : undefined
    })
  } catch {}
})

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
    // renderer 还活着 → 让它弹自绘对话框，回 window:closeConfirmed。
    // renderer 死掉了 → 走原生 messageBox 兜底，保证"任何情况都能确认关闭"。
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send('window:close-request')
        return
      } catch {
        // 落到下面的原生 dialog 兜底
      }
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '确认关闭',
      message: '确认关闭 Claude Terminal？',
      detail: '关闭后所有终端会话将被终止。'
    })
    if (choice === 0) {
      allowClose = true
      fastQuit('user-close-native')
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

// 用户确认关闭 → 走这里"快退"：不给 renderer beforeunload 机会，
// 也不等 Chromium 回收 helper 进程；同步把 PTY 与日志收干净后 app.exit。
// 观测背景：beforeunload 里逐 tab 串行 TerminalTab.dispose()（xterm 6 dispose
// + kill IPC 累加）+ Chromium renderer/helper 回收 = 关闭感知 2~3s。
// 直接 exit 让 OS 成组回收进程，通常 <300ms。
let fastQuitting = false
function fastQuit(reason: string): void {
  if (fastQuitting) return
  fastQuitting = true
  try { stopWatchers() } catch {}
  try { destroyFloater() } catch {}
  try { killAll() } catch {}
  try { stopLogging(reason) } catch {}
  app.exit(0)
}

app.whenReady().then(() => {
  // logger 尽量早启动：ready 之后 electron 事件才能挂，getPath('logs') 也才可用。
  // 上次未走 clean shutdown → sentinel 还在 → start 事件里 unclean_exit=true。
  startLogging({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: `${process.platform}-${process.arch}`
  })

  // Electron 崩溃事件：render 是渲染进程（含 floater），child 是 GPU/utility/plugin。
  // 休眠唤醒后 app 消失，最常见就是 GPU 进程崩了拖着主进程一起走。
  app.on('render-process-gone', (_e, wc, details) => {
    logEvent('render_process_gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: (() => { try { return wc.getURL() } catch { return '' } })()
    })
  })
  app.on('child-process-gone', (_e, details) => {
    logEvent('child_process_gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    })
  })

  // powerMonitor：这是诊断"睡→醒 app 没了"的核心线索。
  // 日志停在 suspend 后 → app 是被系统在休眠期间处理掉的；
  // 有 resume 之后再断 → 唤醒时崩的（多半 GPU/驱动）。
  const power = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown', 'on-ac', 'on-battery'] as const
  for (const ev of power) {
    try { powerMonitor.on(ev as never, () => logEvent('power', { kind: ev })) } catch {}
  }

  registerPtyIpc(() => mainWindow)
  ipcMain.on('window:closeConfirmed', () => {
    allowClose = true
    // 直接 app.exit(0)：跳过 mainWindow.close() → renderer beforeunload → Chromium
    // helper 回收这条慢路径。原本这条路径要 2~3s（xterm 逐 tab dispose + kill IPC
    // 串行 + Chromium 回收），fastQuit 通常 <300ms。
    fastQuit('user-close')
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
  // stop 事件同步落盘 + sentinel 删掉，下次启动才不会误判成 unclean_exit
  stopLogging('window-all-closed')
  // 用 app.exit 而非 app.quit：node-pty 的 conoutSocketWorker.dispose() 会挂一个
  // FLUSH_DATA_INTERVAL=1000ms 的 setTimeout 等最后一段输出 flush 再关 worker,
  // app.quit 是优雅退，会等事件循环排空 → 进程多挂 1s 才消失。
  // 窗口已关、renderer 已退、子进程同步 kill 完了，那 1s flush 没人在读，直接跳过。
  if (process.platform !== 'darwin') app.exit(0)
})

app.on('before-quit', () => {
  // 走 app.exit 时不会触发这里；保留是兜底 —— 例如 second-instance 路径或外部 app.quit()
  // 时仍能把 watcher/pty 清干净（重复调用 stopWatchers/killAll 是幂等的）。
  stopWatchers()
  killAll()
  stopLogging('before-quit')
})
