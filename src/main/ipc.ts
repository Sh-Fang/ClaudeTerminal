import { ipcMain, shell, type BrowserWindow } from 'electron'
import { createPty, killPty, resizePty, writePty } from './pty-manager'
import { loadWorkspace, saveWorkspace, type Workspace } from './workspace'
import { detectClaudePath, isClaudeAvailable, sessionExists } from './claude-helper'
import { ensureHookAssets, type HookPaths } from './hook-assets'
import { readSessionMeta } from './jsonl-reader'
import { loadSettings, saveSettings } from './settings'
import { applyDisableAutoupdater, readUserEnv } from './sys-env'

function shouldDisableAutoupdate(): boolean {
  try { return loadSettings().disableAutoupdater } catch { return true }
}

const SAFE_URL = /^https?:\/\/[^\s'"<>]+$/i

export function registerPtyIpc(getWindow: () => BrowserWindow | null): void {
  let hookPaths: HookPaths | null = null
  const getHookPaths = (): HookPaths => {
    if (!hookPaths) hookPaths = ensureHookAssets()
    return hookPaths
  }
  // 启动即物化，方便首条命令直接引用
  try { getHookPaths() } catch (e) { console.error('[hooks] ensure failed', e) }

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && SAFE_URL.test(url)) {
      void shell.openExternal(url)
      return true
    }
    return false
  })

  ipcMain.handle('workspace:load', () => loadWorkspace())
  ipcMain.handle('workspace:save', (_e, ws: Workspace) => {
    saveWorkspace(ws)
    return true
  })

  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_e, s: unknown) => saveSettings(s))

  ipcMain.handle('sysenv:applyDisableAutoupdater', (_e, enabled: boolean) =>
    applyDisableAutoupdater(!!enabled)
  )
  ipcMain.handle('sysenv:readDisableAutoupdater', () => readUserEnv('DISABLE_AUTOUPDATER'))

  ipcMain.handle('claude:available', () => isClaudeAvailable())
  ipcMain.handle('claude:sessionExists', (_e, sessionId: string) => sessionExists(sessionId))
  ipcMain.handle('claude:sessionMeta', (_e, sessionId: string) => readSessionMeta(sessionId))
  ipcMain.handle('claude:detect', () => detectClaudePath())

  ipcMain.handle(
    'pty:create',
    (_e, opts: { cols?: number; rows?: number; cwd?: string; tabId?: string }) => {
      const env: Record<string, string> = {}
      if (opts?.tabId) {
        const hp = getHookPaths()
        env.TERMINAL_TAB_ID = opts.tabId
        env.TERMINAL_EVENTS_DIR = hp.eventsDir
        env.TERMINAL_STATE_DIR = hp.stateDir
      }
      if (shouldDisableAutoupdate()) {
        env.DISABLE_AUTOUPDATER = '1'
      }
      const id = createPty(
        { cols: opts?.cols, rows: opts?.rows, cwd: opts?.cwd, env },
        (sid, data) => getWindow()?.webContents.send('pty:data', { id: sid, data }),
        (sid, exitCode) => getWindow()?.webContents.send('pty:exit', { id: sid, exitCode })
      )
      return id
    }
  )

  ipcMain.handle('hooks:paths', () => getHookPaths())

  ipcMain.on('pty:input', (_e, p: { id: number; data: string }) => {
    writePty(p.id, p.data)
  })

  ipcMain.on('pty:resize', (_e, p: { id: number; cols: number; rows: number }) => {
    resizePty(p.id, p.cols, p.rows)
  })

  ipcMain.on('pty:kill', (_e, p: { id: number }) => {
    killPty(p.id)
  })
}
