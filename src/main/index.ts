import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerPtyIpc } from './ipc'
import { killAll } from './pty-manager'
import { ensureHookAssets } from './hook-assets'
import { SessionEventWatcher } from './session-events'
import { StateEventWatcher } from './state-events'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  const hp = ensureHookAssets()
  sessionWatcher = new SessionEventWatcher(hp.eventsDir, () => mainWindow)
  stateWatcher = new StateEventWatcher(hp.stateDir, () => mainWindow)
  sessionWatcher.start()
  stateWatcher.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatchers()
  killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopWatchers()
  killAll()
})
