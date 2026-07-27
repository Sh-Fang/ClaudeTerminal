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

let mainWindow: BrowserWindow | null = null
let allowClose = false
let tray: Tray | null = null

// ─── 关闭进托盘 ──────────────────────────────────────────────────
// closeBehavior='tray' 时点关闭：不弹确认，窗口 hide + 挂托盘图标；会话进程全部保留。
// 托盘图标只在「已收进托盘」期间存在，恢复窗口即销毁，平时不占托盘位。
function destroyTray(): void {
  try { tray?.destroy() } catch {}
  tray = null
}

function restoreFromTray(): void {
  destroyTray()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!tray) {
    // Windows 托盘用 ico（小尺寸清晰），其余平台用 png
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    tray = new Tray(join(__dirname, '../../resources', iconFile))
    tray.setToolTip('Claude Terminal（会话仍在运行）')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Claude Terminal', click: () => restoreFromTray() },
      { type: 'separator' },
      {
        label: '退出（终止所有会话）',
        click: () => {
          allowClose = true
          fastQuit('tray-quit')
        }
      }
    ]))
    tray.on('click', () => restoreFromTray())
    tray.on('double-click', () => restoreFromTray())
  }
  mainWindow.hide()
}

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

// argv 里解析 `--open-here <path>`：右键菜单唤起 app 时带路径，主进程通过 IPC 通知
// renderer 新建一个分组承载该路径。argv 首两项是 exe/asar，跳过；path 允许在 --open-here
// 后面用等号或空格分隔。
//
// Chromium/Electron 会往主进程 argv 里塞自己的 flag（--allow-file-access-from-files
// 之类）。如果 --open-here 后面刚好跟了这些 flag，parseOpenHere 会误把 flag 当成路径
// 抛出去，renderer 看到"路径不存在：--allow-file-access-from-files"。这里做两道
// 校验：跳过 - / / 打头（明显是 flag）、跳过不含冒号/斜杠（不像 Windows 绝对路径）。
function looksLikePath(s: string): boolean {
  if (!s) return false
  if (s.startsWith('-')) return false
  // Windows 盘符 D:\、UNC \\server、或 forward slash 都算
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/')
}
// 两条唤起路径拿到的 argv 形态不同：
//   · 首次启动：process.argv 未被 Chromium 加工，形如 [exe, --open-here, D:\path]，
//     路径紧跟 --open-here。
//   · second-instance：Electron 传进来的 argv 是 Chromium CommandLine 重排过的——
//     switch（--xxx）被排到前面、注入自己的 flag（如 --allow-file-access-from-files），
//     裸路径（positional 参数）被挪到 argv 末尾。于是 --open-here 后面紧跟的不再是
//     路径而是注入的 flag，路径掉到最后。实测（Electron 42）：
//       [exe, --open-here, --allow-file-access-from-files, <main脚本>, D:\path]
// 所以不能只看 --open-here 的下一个 token。三级识别：
//   1) 等号形式 --open-here=path：Chromium 把它当整体 switch 保留、不拆散，最稳；
//   2) 裸 flag 紧邻路径：首次启动 process.argv 命中；
//   3) 兜底：只要出现过 --open-here，就从末尾往前找第一个"像路径"的 token
//      （second-instance 场景路径被挪到末尾）。
// 清洗 argv 里取出的路径 token。核心是磁盘根：右键"在此处打开"时 %V 展开成 D:\，
// 命令行 "D:\" 里的 \" 会被 Windows 当转义引号，盘符路径丢掉斜杠、留下一个字面引号，
// argv 里实测（CommandLineToArgvW）拿到的是 D:" 。这是 Windows 命令行固有行为，NSIS
// 命令行层面无法同时兼容磁盘根与普通目录（VSCode 的 "%V" 同样坏成 D:"），只能在此清洗：
//   · Windows 路径本就不允许含 " —— 去掉所有引号；
//   · 清洗后若是纯盘符 D: —— 补回根斜杠成 D:\ 。
function normalizeArgPath(s: string): string {
  const v = s.replace(/"/g, '').trim()
  return /^[a-zA-Z]:$/.test(v) ? v + '\\' : v
}

function parseOpenHere(argv: string[]): string | null {
  let sawFlag = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    // 1) 等号形式：路径绑在 switch 值里，不会被重排拆散
    if (a.startsWith('--open-here=')) {
      const stripped = normalizeArgPath(a.slice('--open-here='.length))
      if (looksLikePath(stripped)) return stripped
      sawFlag = true
      continue
    }
    // 2) 裸 flag：首次启动时路径紧跟其后
    if (a === '--open-here' || a === '/open-here') {
      sawFlag = true
      const v = argv[i + 1]
      if (v) {
        const stripped = normalizeArgPath(v)
        if (looksLikePath(stripped)) return stripped
      }
    }
  }
  // 3) 兜底：second-instance 场景路径被 Chromium 挪到 argv 末尾，倒序捞第一个像路径的。
  //    倒序是关键——dev 下 argv 里还夹着 main 脚本路径（也 looksLikePath），但它排在
  //    真实路径之前，从末尾扫描先命中真实的 %V 路径。生产打包 argv 里只有唯一裸路径。
  //    到 i>=1 为止：argv[0] 永远是 exe/electron 自身路径（也 looksLikePath），万一带了
  //    --open-here 却没有真实路径，不能把 exe 路径误当目标抛出去。
  if (sawFlag) {
    for (let i = argv.length - 1; i >= 1; i--) {
      const v = normalizeArgPath(argv[i] || '')
      if (looksLikePath(v)) return v
    }
  }
  return null
}

// 待消费的 open-here 路径队列。用队列而非单值是因为极端情况可能连续两次触发。
// - 首次启动：process.argv 里 parse 出的 path 直接 push
// - second-instance：无论 renderer ready 与否都 push；如果已 ready 顺带 send 一次触发消费
// renderer 启动 IIFE 完成后会 invoke 'app:consumePendingOpenHere' 主动拉走队列——
// 之前用 send + did-finish-load 会在 renderer 的 onOpenHere 监听器注册前送达而被丢弃，
// 现在改成主动拉取，只要监听器就位就一定能拿到。
const pendingOpenHere: string[] = []
{
  const initial = parseOpenHere(process.argv)
  if (initial) pendingOpenHere.push(initial)
}

function safeSendOpenHere(path: string): void {
  // send 只是"顺手催一下"（second-instance 场景 renderer 已 ready）；主要落盘还是靠 pendingOpenHere
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
    // 收在托盘里时再次启动 app → 不开新实例，把托盘里的窗口拉回来
    if (!mainWindow.isVisible()) restoreFromTray()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // 第二实例带 --open-here → push 到 pending 队列，并顺手 send 一次触发 renderer 消费
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
    // Windows/Linux：完全无边框，自绘标题栏 + 窗口按钮。
    // macOS：用 hiddenInset 保留系统红绿灯（画在左侧），标题栏区仍可拖动；
    //        渲染层据 platform 隐藏自绘的右侧窗口按钮，避免与红绿灯重复。
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
    // 托盘模式：跳过一切确认，直接收进托盘（会话保留，从托盘/再次启动可回来）
    try {
      if (loadSettings().closeBehavior === 'tray') {
        hideToTray()
        return
      }
    } catch {}
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
  mainWindow.on('closed', () => { destroyFloater(); destroyTray() })

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
// 也不等 Chromium 回收 helper 进程；收干净日志后直接 app.exit，让 OS 成组回收进程。
// 观测背景：beforeunload 里逐 tab 串行 TerminalTab.dispose()（xterm 6 dispose
// + kill IPC 累加）+ Chromium renderer/helper 回收 = 关闭感知 2~3s。
//
// 关键：这里刻意不再调 killAll()。proc.kill() 在 Windows ConPTY 下是【同步阻塞】——
// 每次要跑 conpty_console_list 枚举进程树 + 逐个 process.kill + 关 pseudoconsole，
// 单个实测 300~750ms，串行 killAll 随 tab 数线性放大（8 个会话实测卡主线程 ≈ 3.9s），
// 这正是"标签页一多、关闭就慢"的根因。而马上就要 app.exit(0)：进程退出时 OS 关闭
// ConPTY 句柄，会自动终止挂在其上的 pwsh 及其子进程（实测无孤儿残留），无需我们逐个杀。
// TerminateProcess 级别的立即退出：不跑 CRT/atexit 静态析构。
// app.exit(0) 底层走 exit()，会执行 native 模块析构 —— node-pty 的 ConPTY agent
// 线程这时可能正好回调 OnProcessExit，撞上已拆掉的 baton 表，弹出
// "Assertion failed: remove_pty_baton(baton->id)" 断言框（conpty.cc:106）。
// SIGKILL 在 Windows 上由 libuv 映射为 TerminateProcess：OS 直接回收进程，
// ConPTY 句柄随之关闭、挂在其上的 pwsh 树自动终止，效果与 app.exit 一致且无竞态。
// 注意：调用前必须已完成所有需要落盘的收尾（stopLogging 等都是同步写）。
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
  // 主动拉取：renderer 启动 IIFE 完成后 invoke 一次，把首次启动 argv 里带来的路径取走。
  ipcMain.handle('app:consumePendingOpenHere', () => {
    const out = [...pendingOpenHere]
    pendingOpenHere.length = 0
    return out
  })
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
  // 首次启动的路径已经在 pendingOpenHere 里；等 renderer 主动 invoke consumePendingOpenHere 消费。
  // 启动时按设置决定是否拉起悬浮窗
  try {
    if (loadSettings().showFloater) setFloaterEnabled(true)
  } catch {}
  // claudePath 为空（首次启动 / 从未配置）→ 自动检测一次并持久化；
  // 找到就写死绝对路径，之后由 CC 版本管理接手维护。找不到保持空（走 PATH）。
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
  // stop 事件同步落盘 + sentinel 删掉，下次启动才不会误判成 unclean_exit
  stopLogging('window-all-closed')
  if (process.platform !== 'darwin') {
    // Windows/Linux：进程要退了，硬退（TerminateProcess，见 hardExit 注释）。
    // 不逐个 proc.kill()（同步阻塞、随 tab 线性放大），OS 关闭 ConPTY 句柄即回收
    // 挂在其上的 pwsh；也不走 app.exit —— exit() 的析构会和 conpty 线程竞态弹断言框。
    hardExit()
  } else {
    // macOS：窗口全关进程仍活着，必须把子进程收干净，否则泄漏
    killAll()
  }
})

app.on('before-quit', () => {
  // 走 app.exit 时不会触发这里；保留是兜底 —— 例如 second-instance 路径或外部 app.quit()
  // 时仍能把 watcher/pty 清干净（重复调用 stopWatchers/killAll 是幂等的）。
  stopWatchers()
  killAll()
  stopLogging('before-quit')
})
