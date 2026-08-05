import { app, BrowserWindow as BrowserWindowClass, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { createPty, killPty, resizePty, writePty } from './pty-manager'
import { loadWorkspace, saveWorkspace, type Workspace } from './workspace'
import { detectClaudePath, isClaudeAvailable, sessionExists } from './claude-helper'
import {
  cancelInstall as ccCancelInstall,
  install as ccInstall,
  listInstalled as ccListInstalled,
  listRemote as ccListRemote,
  uninstall as ccUninstall,
  versionFromPath as ccVersionFromPath
} from './cc-versions'
import { ensureHookAssets, type HookPaths } from './hook-assets'
import { readSessionMeta, readSessionUsage } from './jsonl-reader'
import { readGitBranch } from './git-info'
import { loadSettings, saveSettings, type Settings } from './settings'
import { applyDisableAutoupdater, readUserEnv } from './sys-env'
import { readClipboardSelection, writeClipboardText } from './clipboard'
import { getClaudeUsage } from './claude-usage'
import { isSafeExternalUrl } from './url-safety'
import { t } from './i18n'
import {
  clearTabHistory,
  deleteManyTabHistory,
  deleteTabHistory,
  listTabHistory,
  upsertTabHistory,
  type HistoryEntry
} from './tab-history'
import { moveFloaterTo, pushCountsToFloater, setFloaterDragging, setFloaterEnabled, setFloaterFocusable } from './floater'

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

  // 用系统资源管理器打开本地目录/文件。仅接受绝对路径且路径存在，避免被塞相对路径逃出预期目录。
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: '空路径' }
    try {
      if (!existsSync(p)) return { ok: false, error: '路径不存在' }
    } catch {
      return { ok: false, error: '路径不可访问' }
    }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
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

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('claude:available', () => isClaudeAvailable())
  ipcMain.handle('claude:sessionExists', (_e, sessionId: string) => sessionExists(sessionId))
  ipcMain.handle('claude:sessionMeta', (_e, sessionId: string) => readSessionMeta(sessionId))
  ipcMain.handle('claude:detect', () => detectClaudePath())
  ipcMain.handle('cc:listInstalled', () => {
    try { return ccListInstalled(loadSettings().claudePath) } catch { return [] }
  })
  ipcMain.handle('cc:listRemote', async () => {
    try { return { ok: true, versions: await ccListRemote(loadSettings().npmRegistry) } }
    catch (e) { return { ok: false, error: (e as Error).message, versions: [] as string[] } }
  })
  ipcMain.handle('cc:install', async (e, version: string) => {
    if (typeof version !== 'string' || !version.trim()) {
      return { ok: false, version, error: '版本号为空' }
    }
    const wc = e.sender
    const ver = version.trim()
    const onPhase = (phase: string): void => {
      if (!wc || wc.isDestroyed()) return
      try { wc.send('cc:install:phase', { version: ver, phase }) } catch {}
    }
    return ccInstall(ver, loadSettings().npmRegistry, onPhase)
  })
  ipcMain.handle('cc:uninstall', (_e, version: string) =>
    typeof version === 'string' ? ccUninstall(version) : { ok: false, error: '版本号非法' }
  )
  ipcMain.handle('cc:installCancel', (_e, version: string) =>
    typeof version === 'string' ? ccCancelInstall(version) : { ok: false, error: '版本号非法' }
  )
  ipcMain.handle('cc:currentVersion', () => {
    try { return ccVersionFromPath(loadSettings().claudePath) } catch { return null }
  })
  ipcMain.handle('claude:usage', (_e, force?: boolean) => getClaudeUsage(!!force))
  ipcMain.handle('claude:sessionUsage', (_e, sessionId: string) => readSessionUsage(sessionId))
  ipcMain.handle('git:branch', (_e, cwd: string) => readGitBranch(cwd))

  ipcMain.handle('path:exists', (_e, p: string) => {
    if (typeof p !== 'string' || !p) return false
    try { return existsSync(p) } catch { return false }
  })

  ipcMain.handle(
    'pty:create',
    (_e, opts: { cols?: number; rows?: number; cwd?: string; tabId?: string; tabName?: string }) => {
      if (opts?.cwd) {
        try {
          if (!existsSync(opts.cwd)) throw new Error(`目录不存在: ${opts.cwd}`)
          if (!statSync(opts.cwd).isDirectory()) throw new Error(`不是目录: ${opts.cwd}`)
        } catch (e) {
          throw new Error((e as Error).message || '路径无效')
        }
      }
      const env: Record<string, string> = {}
      const hp = getHookPaths()
      if (opts?.tabId) {
        env.TERMINAL_TAB_ID = opts.tabId
        env.TERMINAL_EVENTS_DIR = hp.eventsDir
        env.TERMINAL_STATE_DIR = hp.stateDir
      }
      // cct 命令依赖：让 pwsh profile 里的 cct 能直接拿到 hooks 配置 + claude 路径 + tab 名。
      // tab name 只在 pty 首次 spawn 时快照；用户后续改名 env 不跟进，cct 会用旧名（可接受）。
      env.TERMINAL_HOOK_SETTINGS_JSON = hp.ccHooksJson
      if (opts?.tabName) env.TERMINAL_TAB_NAME = opts.tabName
      try {
        const cp = loadSettings().claudePath?.trim()
        if (cp) env.TERMINAL_CLAUDE_PATH = cp
      } catch {}
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
        {
          cols: opts?.cols,
          rows: opts?.rows,
          cwd: opts?.cwd,
          env,
          profiles: { pwsh: hp.pwshProfilePs1, zsh: hp.zshProfile, bash: hp.bashProfile }
        },
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
      title: t('选择路径'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.on('pty:input', (_e, p: { id: number; data: string }) => {
    writePty(p.id, p.data)
  })

  // 环境变量开关：启动前 set TERM_DEBUG=1 打开主进程侧日志（resize/kill 时机）。
  // 跟 renderer 的 window.__termDebug 配合看完整链路。
  const ptyDbg = process.env.TERM_DEBUG === '1'
  const ptyDbgLog = (...args: unknown[]): void => {
    if (ptyDbg) console.log('[pty]', ...args)
  }

  ipcMain.on('pty:resize', (_e, p: { id: number; cols: number; rows: number }) => {
    ptyDbgLog(`resize id=${p.id} cols=${p.cols} rows=${p.rows}`)
    resizePty(p.id, p.cols, p.rows)
  })

  ipcMain.on('pty:kill', (_e, p: { id: number }) => {
    ptyDbgLog(`kill id=${p.id}`)
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

  ipcMain.on('floater:setEnabled', (_e, on: boolean) => setFloaterEnabled(!!on))
  ipcMain.on('floater:push', (_e, counts: unknown) => {
    if (!counts || typeof counts !== 'object') return
    const c = counts as Record<string, unknown>
    const n = (v: unknown): number => {
      const x = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0
    }
    pushCountsToFloater({
      done: n(c.done),
      attention: n(c.attention),
      busy: n(c.busy),
      total: n(c.total)
    })
  })
  // 悬浮窗 focusable:false，自己 click 不能切焦点，转手让主进程把主窗口拉到前台
  ipcMain.on('floater:focusMain', () => {
    const w = getWindow()
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  ipcMain.on('floater:setFocusable', (_e, on: boolean) => setFloaterFocusable(!!on))
  // 手动拖动：目标坐标 + 拖动起止（拖动中挂起穿透轮询）
  ipcMain.on('floater:moveTo', (_e, p: { x: number; y: number }) => {
    if (!p || typeof p !== 'object') return
    moveFloaterTo(Number(p.x), Number(p.y))
  })
  ipcMain.on('floater:dragState', (_e, on: boolean) => setFloaterDragging(!!on))

  ipcMain.on('floater:hide', () => {
    setFloaterEnabled(false)
    // 落盘 showFloater=false，下次启动也不会再拉起
    try {
      const cur = loadSettings()
      saveSettings({ ...cur, showFloater: false } as Settings)
    } catch {}
    // 通知主渲染层同步内存 settings，免得设置面板还显示"开"
    const mainWin = getWindow()
    if (!mainWin || mainWin.isDestroyed()) return
    const wc = mainWin.webContents
    if (!wc || wc.isDestroyed()) return
    try { wc.send('floater:hidden') } catch {}
  })
}
