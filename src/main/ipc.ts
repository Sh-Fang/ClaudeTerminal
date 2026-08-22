import { app, BrowserWindow as BrowserWindowClass, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
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
import { checkForUpdate, quitAndInstallUpdate, setUpdateEventSink } from './update-check'
import { t } from './i18n'
import {
  clearTabHistory,
  deleteManyTabHistory,
  deleteTabHistory,
  listTabHistory,
  upsertTabHistory,
  upsertManyTabHistory,
  type HistoryEntry
} from './tab-history'
import { moveFloaterTo, pushCountsToFloater, setFloaterDragging, setFloaterEnabled, setFloaterFocusable } from './floater'
import { routePtyData, setPtyRoute, releasePty } from './tab-router'
import { allAppWebContents } from './windows'

function shouldDisableAutoupdate(): boolean {
  try { return loadSettings().disableAutoupdater } catch { return true }
}

// npm 镜像开关关闭时 cc 版本管理走官方源（渲染层下拉里它也是候选之一）
const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org'
function effectiveNpmRegistry(): string {
  const s = loadSettings()
  return s.npmMirrorEnabled ? s.npmRegistry : NPM_OFFICIAL_REGISTRY
}

// npm 镜像测速：HEAD 请求测响应头到达耗时，任何状态码都算通；超时/连不上返回 -1
function pingRegistry(rawUrl: string): Promise<number> {
  return new Promise((resolve) => {
    let u: URL
    try { u = new URL(rawUrl) } catch { resolve(-1); return }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { resolve(-1); return }
    const t0 = Date.now()
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      { method: 'HEAD', timeout: 5000 },
      (res) => {
        res.destroy()
        resolve(Date.now() - t0)
      }
    )
    req.on('timeout', () => { req.destroy(); resolve(-1) })
    req.on('error', () => resolve(-1))
    req.end()
  })
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

  // 系统资源管理器打开本地路径；仅接受存在的路径
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

  // 多窗口一致性：任一窗口落盘后广播其余窗口刷新内存副本（并发写仍是后写覆盖，实用上足够）
  const broadcastExcept = (sender: Electron.WebContents, channel: string, payload?: unknown): void => {
    for (const wc of allAppWebContents()) {
      if (wc === sender || wc.isDestroyed()) continue
      try { wc.send(channel, payload) } catch {}
    }
  }

  ipcMain.handle('workspace:load', () => loadWorkspace())
  ipcMain.handle('workspace:save', (e, ws: Workspace) => {
    saveWorkspace(ws)
    broadcastExcept(e.sender, 'workspace:changed')
    return true
  })

  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (e, s: unknown) => {
    const normed = saveSettings(s)
    broadcastExcept(e.sender, 'settings:changed', normed)
    return normed
  })

  ipcMain.handle('clipboard:read', () => readClipboardSelection())
  ipcMain.handle('clipboard:write', (_e, text: unknown) =>
    typeof text === 'string' ? writeClipboardText(text) : false
  )

  ipcMain.handle('sysenv:applyDisableAutoupdater', (_e, enabled: boolean) =>
    applyDisableAutoupdater(!!enabled)
  )
  ipcMain.handle('sysenv:readDisableAutoupdater', () => readUserEnv('DISABLE_AUTOUPDATER'))

  // 开机自启：系统登录项（注册表 Run 键）即唯一事实源，不落 settings.json
  ipcMain.handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:setAutoLaunch', (_e, enabled: boolean) => {
    // 开发模式下登录项会指向 electron.exe，写了也没意义
    if (!app.isPackaged) return { ok: false }
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return { ok: true }
  })

  ipcMain.handle('update:check', () => checkForUpdate())
  ipcMain.handle('update:install', () => { quitAndInstallUpdate(); return true })
  // 下载进度/完成/出错 → 广播所有窗口（设置面板可能开在任一窗口）
  setUpdateEventSink((ev) => {
    for (const wc of allAppWebContents()) {
      if (wc.isDestroyed()) continue
      try { wc.send('update:event', ev) } catch {}
    }
  })

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
    try { return { ok: true, versions: await ccListRemote(effectiveNpmRegistry()) } }
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
    return ccInstall(ver, effectiveNpmRegistry(), onPhase)
  })
  ipcMain.handle('npm:ping', (_e, url: string) => pingRegistry(String(url ?? '')))
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
      // cct 命令依赖的 env；tab 名只在 spawn 时快照，后续改名不跟进（可接受）
      env.TERMINAL_HOOK_SETTINGS_JSON = hp.ccHooksJson
      if (opts?.tabName) env.TERMINAL_TAB_NAME = opts.tabName
      try {
        const cp = loadSettings().claudePath?.trim()
        if (cp) env.TERMINAL_CLAUDE_PATH = cp
      } catch {}
      if (shouldDisableAutoupdate()) {
        env.DISABLE_AUTOUPDATER = '1'
      }
      // 多窗口：数据/退出按 ptyId 路由到承载窗口，创建时路由指向发起窗口
      const id = createPty(
        {
          cols: opts?.cols,
          rows: opts?.rows,
          cwd: opts?.cwd,
          env,
          profiles: { pwsh: hp.pwshProfilePs1, zsh: hp.zshProfile, bash: hp.bashProfile }
        },
        (sid, data) => routePtyData(sid, 'pty:data', { id: sid, data }),
        (sid, exitCode) => {
          routePtyData(sid, 'pty:exit', { id: sid, exitCode })
          releasePty(sid)
        }
      )
      setPtyRoute(id, _e.sender)
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

  // TERM_DEBUG=1 打开主进程侧 pty 日志
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
  ipcMain.handle('tabHistory:upsertMany', (_e, entries: HistoryEntry[]) => {
    upsertManyTabHistory(entries)
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
  // 悬浮窗计数聚合：按窗口记账求和；窗口销毁时清零其份额避免幽灵计数
  const floaterCountsByWc = new Map<Electron.WebContents, { done: number; attention: number; busy: number; total: number }>()
  const pushAggregated = (): void => {
    const sum = { done: 0, attention: 0, busy: 0, total: 0 }
    for (const c of floaterCountsByWc.values()) {
      sum.done += c.done; sum.attention += c.attention; sum.busy += c.busy; sum.total += c.total
    }
    pushCountsToFloater(sum)
  }
  ipcMain.on('floater:push', (e, counts: unknown) => {
    if (!counts || typeof counts !== 'object') return
    const c = counts as Record<string, unknown>
    const n = (v: unknown): number => {
      const x = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0
    }
    if (!floaterCountsByWc.has(e.sender)) {
      e.sender.once('destroyed', () => {
        floaterCountsByWc.delete(e.sender)
        pushAggregated()
      })
    }
    floaterCountsByWc.set(e.sender, {
      done: n(c.done),
      attention: n(c.attention),
      busy: n(c.busy),
      total: n(c.total)
    })
    pushAggregated()
  })
  // 悬浮窗 focusable:false，切焦点需转手主进程把主窗口拉前台
  ipcMain.on('floater:focusMain', () => {
    const w = getWindow()
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  ipcMain.on('floater:setFocusable', (_e, on: boolean) => setFloaterFocusable(!!on))
  ipcMain.on('floater:moveTo', (_e, p: { x: number; y: number }) => {
    if (!p || typeof p !== 'object') return
    moveFloaterTo(Number(p.x), Number(p.y))
  })
  ipcMain.on('floater:dragState', (_e, on: boolean) => setFloaterDragging(!!on))

  ipcMain.on('floater:hide', () => {
    setFloaterEnabled(false)
    // 落盘 showFloater=false，并通知主渲染层同步内存 settings
    try {
      const cur = loadSettings()
      saveSettings({ ...cur, showFloater: false } as Settings)
    } catch {}
    const mainWin = getWindow()
    if (!mainWin || mainWin.isDestroyed()) return
    const wc = mainWin.webContents
    if (!wc || wc.isDestroyed()) return
    try { wc.send('floater:hidden') } catch {}
  })
}
