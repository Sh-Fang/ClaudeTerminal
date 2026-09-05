import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell, Tray } from 'electron'
import { join } from 'node:path'
import { registerPtyIpc } from './ipc'
import { killAll } from './pty-manager'
import { ensureHookAssets } from './hook-assets'
import { SessionEventWatcher } from './session-events'
import { StateEventWatcher } from './state-events'
import { isSafeExternalUrl } from './url-safety'
import { setFloaterEnabled, destroyFloater } from './floater'
import { loadSettings, saveSettings } from './settings'
import { detectClaudePath } from './claude-helper'
import { logEvent, startLogging, stopLogging } from './app-log'
import { setLanguage, t } from './i18n'
import { setFallbackWcGetter, dropWc } from './tab-router'
import { killPty } from './pty-manager'
import {
  setMainWindowGetter,
  registerWindowIpc,
  isSecondaryWindow,
  destroyAllSecondary,
  setSecondaryWindowsCloseAllowed
} from './windows'

// 界面语言启动时定死，切换走 app:relaunch 重启生效
try { setLanguage(loadSettings().language) } catch {}

let mainWindow: BrowserWindow | null = null
let allowClose = false
let updateInstallQuit = false
let tray: Tray | null = null

function prepareUpdateInstallQuit(): void {
  updateInstallQuit = true
  allowClose = true
  setSecondaryWindowsCloseAllowed(true)
}

function rollbackUpdateInstallQuit(): void {
  updateInstallQuit = false
  allowClose = false
  setSecondaryWindowsCloseAllowed(false)
}

// 常驻托盘：closeBehavior='tray' 时点关闭不弹确认，窗口 hide、会话保留，从托盘唤回。
function destroyTray(): void {
  try { tray?.destroy() } catch {}
  tray = null
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// 幂等创建常驻托盘
function ensureTray(): void {
  if (tray) return
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  tray = new Tray(join(__dirname, '../../resources', iconFile))
  tray.setToolTip('Claude Terminal')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('打开 Claude Terminal'), click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: t('退出（终止所有会话）'),
      click: () => {
        allowClose = true
        fastQuit('tray-quit')
      }
    }
  ]))
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

function hideToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  ensureTray()
  mainWindow.hide()
}

// 未捕获错误尽早注册；startLogging 之后的都会 JSONL 落盘
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

// 解析 `--open-here <path>`（右键菜单唤起带路径）。Chromium 会往 argv 塞自己的 flag，
// 必须校验 token "像路径"才收，否则会把注入 flag 误当路径。
function looksLikePath(s: string): boolean {
  if (!s) return false
  if (s.startsWith('-')) return false
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/')
}
// 清洗路径 token：磁盘根 "D:\" 经 Windows 命令行转义会变成 D:"（固有行为），
// 去掉所有引号后若是纯盘符再补回根斜杠。
function normalizeArgPath(s: string): string {
  const v = s.replace(/"/g, '').trim()
  return /^[a-zA-Z]:$/.test(v) ? v + '\\' : v
}

function parseOpenHere(argv: string[]): string | null {
  let sawFlag = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    // 等号形式最稳：Chromium 不会拆散整体 switch
    if (a.startsWith('--open-here=')) {
      const stripped = normalizeArgPath(a.slice('--open-here='.length))
      if (looksLikePath(stripped)) return stripped
      sawFlag = true
      continue
    }
    // 裸 flag：首次启动时路径紧跟其后
    if (a === '--open-here' || a === '/open-here') {
      sawFlag = true
      const v = argv[i + 1]
      if (v) {
        const stripped = normalizeArgPath(v)
        if (looksLikePath(stripped)) return stripped
      }
    }
  }
  // 兜底：second-instance 时 Chromium 会把裸路径重排到 argv 末尾，倒序捞第一个像路径的；
  // 跳过 argv[0]（exe 自身路径也 looksLikePath）。
  if (sawFlag) {
    for (let i = argv.length - 1; i >= 1; i--) {
      const v = normalizeArgPath(argv[i] || '')
      if (looksLikePath(v)) return v
    }
  }
  return null
}

// 待消费的 open-here 路径队列；renderer 就绪后 invoke 'app:consumePendingOpenHere' 主动拉取
// （被动 send 可能在监听器注册前送达而丢失）。
const pendingOpenHere: string[] = []
{
  const initial = parseOpenHere(process.argv)
  if (initial) pendingOpenHere.push(initial)
}

function safeSendOpenHere(path: string): void {
  // send 只是催一下消费；主要靠 pendingOpenHere 队列
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = mainWindow.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.send('app:openHere', path) } catch {}
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    showMainWindow()
    const p = parseOpenHere(argv)
    if (p) {
      pendingOpenHere.push(p)
      safeSendOpenHere(p)
    }
  })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    backgroundColor: '#ffffff',
    // Windows/Linux 无边框自绘标题栏；macOS 用 hiddenInset 保留系统红绿灯
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
    // 托盘模式：跳过确认直接收进托盘，会话保留
    try {
      if (loadSettings().closeBehavior === 'tray') {
        hideToTray()
        return
      }
    } catch {}
    const wc = mainWindow.webContents
    // renderer 活着 → 自绘对话框回 window:closeConfirmed；死了 → 原生 messageBox 兜底
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send('window:close-request')
        return
      } catch {}
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: [t('关闭'), t('取消')],
      defaultId: 1,
      cancelId: 1,
      title: t('确认关闭'),
      message: t('确认关闭 Claude Terminal？'),
      detail: t('关闭后所有终端会话将被终止。')
    })
    if (choice === 0) {
      allowClose = true
      fastQuit('user-close-native')
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 主窗口销毁 = 整个 app 退出，把悬浮窗/副窗口一并带走
  mainWindow.on('closed', () => { destroyFloater(); destroyTray(); destroyAllSecondary() })

  // 渲染进程销毁时清路由表（防崩溃残留；正常退出 PTY 由退出流程统一回收）
  mainWindow.webContents.on('destroyed', () => {
    if (mainWindow && !fastQuitting) {
      for (const ptyId of dropWc(mainWindow.webContents)) {
        try { killPty(ptyId) } catch {}
      }
    }
  })

  // window.open 只放行 http(s)，挡掉 file:/自定义协议
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁止应用页面被导航走；外部链接走 openExternal
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

// 快退：刻意不调 killAll()——ConPTY 下 proc.kill() 同步阻塞（单个 300~750ms，随 tab 线性放大），
// 而进程退出时 OS 关闭 ConPTY 句柄会自动终止挂在其上的 pwsh 树，无孤儿残留。
// 用 SIGKILL（libuv 映射 TerminateProcess）而非 app.exit：exit() 的 native 析构会与
// node-pty conpty 线程竞态弹断言框。调用前须完成所有同步落盘收尾。
function hardExit(): void {
  try { process.kill(process.pid, 'SIGKILL') } catch {}
  app.exit(0) // 兜底，正常到不了这行
}

let fastQuitting = false
function fastQuit(reason: string): void {
  if (fastQuitting) return
  fastQuitting = true
  try { stopWatchers() } catch {}
  try { destroyTray() } catch {}
  try { destroyFloater() } catch {}
  try { stopLogging(reason) } catch {}
  hardExit()
}

app.whenReady().then(() => {
  // logger 尽早启动（getPath('logs') 需在 ready 后）
  startLogging({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: `${process.platform}-${process.arch}`
  })

  // 崩溃事件落日志：休眠唤醒后 app 消失多为 GPU 进程崩溃拖垮主进程
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

  // powerMonitor 事件落日志：诊断"睡→醒后 app 消失"的时间线
  const power = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown', 'on-ac', 'on-battery'] as const
  for (const ev of power) {
    try { powerMonitor.on(ev as never, () => logEvent('power', { kind: ev })) } catch {}
  }

  // 多窗口基建：路由兜底指向主窗口；windows.ts 拿主窗口引用；注册迁移相关 IPC
  setFallbackWcGetter(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null))
  setMainWindowGetter(() => mainWindow)
  registerWindowIpc()
  registerPtyIpc(() => mainWindow, {
    prepare: prepareUpdateInstallQuit,
    rollback: rollbackUpdateInstallQuit
  })
  // renderer 启动完成后 invoke 一次，取走首次启动 argv 里的路径
  ipcMain.handle('app:consumePendingOpenHere', () => {
    const out = [...pendingOpenHere]
    pendingOpenHere.length = 0
    return out
  })
  // 显式重启不能走 hardExit：SIGKILL 会让 app.relaunch 失效。
  // 先同步 killAll 收干净 conpty（避免 exit() 析构与 conpty 线程竞态），再 app.exit。
  ipcMain.on('app:relaunch', () => {
    allowClose = true
    app.relaunch()
    try { stopWatchers() } catch {}
    try { destroyTray() } catch {}
    try { destroyFloater() } catch {}
    try { destroyAllSecondary() } catch {}
    try { killAll() } catch {}
    try { stopLogging('relaunch') } catch {}
    app.exit(0)
  })
  ipcMain.on('window:closeConfirmed', (e) => {
    // 副窗口：只销毁该窗口（destroyed 监听清路由表 + 杀名下 PTY），app 继续跑
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && isSecondaryWindow(win)) {
      try { win.destroy() } catch {}
      return
    }
    allowClose = true
    // 主窗口：fastQuit 跳过 beforeunload/Chromium 回收慢路径（2~3s → <300ms）
    fastQuit('user-close')
  })
  const hp = ensureHookAssets()
  sessionWatcher = new SessionEventWatcher(hp.eventsDir)
  stateWatcher = new StateEventWatcher(hp.stateDir)
  sessionWatcher.start()
  stateWatcher.start()
  createWindow()
  ensureTray()
  // 按设置决定是否拉起悬浮窗
  try {
    if (loadSettings().showFloater) setFloaterEnabled(true)
  } catch {}
  // claudePath 为空 → 自动检测一次并持久化绝对路径；找不到保持空（走 PATH）
  try {
    const s = loadSettings()
    if (!s.claudePath.trim()) {
      const detected = detectClaudePath()
      if (detected) {
        saveSettings({ ...s, claudePath: detected })
        logEvent('claude_path_autodetected', { path: detected })
      }
    }
  } catch {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatchers()
  destroyFloater()
  stopLogging('window-all-closed')
  // quitAndInstall 已启动安装器并调用 app.quit；这里不能用 SIGKILL 截断退出时序。
  if (updateInstallQuit) return
  if (process.platform !== 'darwin') {
    // Windows/Linux 硬退（理由见 hardExit）
    hardExit()
  } else {
    // macOS 窗口全关进程仍活着，必须收干净子进程
    killAll()
  }
})

app.on('before-quit', () => {
  // app.exit 不触发这里；兜底外部 app.quit() 路径（重复调用幂等）
  stopWatchers()
  killAll()
  stopLogging('before-quit')
})
