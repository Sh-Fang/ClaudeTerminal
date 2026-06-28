import { BrowserWindow as BrowserWindowClass, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { createPty, killPty, resizePty, writePty } from './pty-manager'
import { loadWorkspace, saveWorkspace, type Workspace } from './workspace'
import { detectClaudePath, isClaudeAvailable, sessionExists } from './claude-helper'
import { ensureHookAssets, type HookPaths } from './hook-assets'
import { readSessionMeta, readSessionUsage } from './jsonl-reader'
import { readGitBranch } from './git-info'
import { loadSettings, saveSettings } from './settings'
import { applyDisableAutoupdater, readUserEnv } from './sys-env'
import { readClipboardSelection, writeClipboardText } from './clipboard'
import { getClaudeUsage } from './claude-usage'
import { isSafeExternalUrl } from './url-safety'
import {
  clearTabHistory,
  deleteManyTabHistory,
  deleteTabHistory,
  listTabHistory,
  upsertTabHistory,
  type HistoryEntry
} from './tab-history'

function shouldDisableAutoupdate(): boolean {
  try { return loadSettings().disableAutoupdater } catch { return true }
}

export function registerPtyIpc(getWindow: () => BrowserWindow | null): void {
  let hookPaths: HookPaths | null = null
  const getHookPaths = (): HookPaths => {
    if (!hookPaths) hookPaths = ensureHookAssets()
    return hookPaths
  }
  // 启动即物化，方便首条命令直接引用
  try { getHookPaths() } catch (e) { console.error('[hooks] ensure failed', e) }

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (isSafeExternalUrl(url)) {
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

  ipcMain.handle('clipboard:read', () => readClipboardSelection())
  ipcMain.handle('clipboard:write', (_e, text: unknown) =>
    typeof text === 'string' ? writeClipboardText(text) : false
  )

  ipcMain.handle('sysenv:applyDisableAutoupdater', (_e, enabled: boolean) =>
    applyDisableAutoupdater(!!enabled)
  )
  ipcMain.handle('sysenv:readDisableAutoupdater', () => readUserEnv('DISABLE_AUTOUPDATER'))

  const winFromEvent = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindowClass.fromWebContents(e.sender) ?? getWindow()

  ipcMain.on('window:minimize', (e) => winFromEvent(e)?.minimize())
  ipcMain.on('window:close', (e) => winFromEvent(e)?.close())
  ipcMain.on('window:toggleMaximize', (e) => {
    const w = winFromEvent(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('window:isMaximized', (e) => winFromEvent(e)?.isMaximized() ?? false)

  ipcMain.handle('claude:available', () => isClaudeAvailable())
  ipcMain.handle('claude:sessionExists', (_e, sessionId: string) => sessionExists(sessionId))
  ipcMain.handle('claude:sessionMeta', (_e, sessionId: string) => readSessionMeta(sessionId))
  ipcMain.handle('claude:detect', () => detectClaudePath())
  ipcMain.handle('claude:usage', (_e, force?: boolean) => getClaudeUsage(!!force))
  ipcMain.handle('claude:sessionUsage', (_e, sessionId: string) => readSessionUsage(sessionId))
  ipcMain.handle('git:branch', (_e, cwd: string) => readGitBranch(cwd))

  ipcMain.handle('path:exists', (_e, p: string) => {
    if (typeof p !== 'string' || !p) return false
    try { return existsSync(p) } catch { return false }
  })

  ipcMain.handle(
    'pty:create',
    (_e, opts: { cols?: number; rows?: number; cwd?: string; tabId?: string }) => {
      if (opts?.cwd) {
        try {
          if (!existsSync(opts.cwd)) throw new Error(`目录不存在: ${opts.cwd}`)
          if (!statSync(opts.cwd).isDirectory()) throw new Error(`不是目录: ${opts.cwd}`)
        } catch (e) {
          throw new Error((e as Error).message || '路径无效')
        }
      }
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
      const safeSend = (channel: string, payload: unknown): void => {
        const w = getWindow()
        if (!w || w.isDestroyed()) return
        const wc = w.webContents
        if (!wc || wc.isDestroyed()) return
        try { wc.send(channel, payload) } catch {}
      }
      const id = createPty(
        { cols: opts?.cols, rows: opts?.rows, cwd: opts?.cwd, env },
        (sid, data) => safeSend('pty:data', { id: sid, data }),
        (sid, exitCode) => safeSend('pty:exit', { id: sid, exitCode })
      )
      return id
    }
  )

  ipcMain.handle('hooks:paths', () => getHookPaths())

  ipcMain.handle('dialog:pickDirectory', async (_e, defaultPath?: string) => {
    const w = getWindow()
    const res = await dialog.showOpenDialog(w ?? undefined as unknown as BrowserWindow, {
      title: '选择路径',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.on('pty:input', (_e, p: { id: number; data: string }) => {
    writePty(p.id, p.data)
  })

  ipcMain.on('pty:resize', (_e, p: { id: number; cols: number; rows: number }) => {
    resizePty(p.id, p.cols, p.rows)
  })

  ipcMain.on('pty:kill', (_e, p: { id: number }) => {
    killPty(p.id)
  })

  ipcMain.handle('tabHistory:list', () => listTabHistory())
  ipcMain.handle('tabHistory:upsert', (_e, entry: HistoryEntry) => {
    upsertTabHistory(entry)
    return true
  })
  ipcMain.handle('tabHistory:delete', (_e, tabId: string) => {
    deleteTabHistory(tabId)
    return true
  })
  ipcMain.handle('tabHistory:deleteMany', (_e, tabIds: string[]) => {
    deleteManyTabHistory(tabIds)
    return true
  })
  ipcMain.handle('tabHistory:clear', () => {
    clearTabHistory()
    return true
  })
}
