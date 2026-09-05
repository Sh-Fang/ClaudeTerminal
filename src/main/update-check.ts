// 应用内更新：electron-updater 走 GitHub Releases 的 latest.yml。
// 检查、下载、安装三个阶段均显式触发；进度/完成经事件回推发起更新的渲染层。
// 仓库私有/尚无 Release 时 API 是 404，归类为 notfound 由 UI 提示「暂无可用的发布版本」。
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateActionResult, UpdateCheckResult, UpdateEvent } from '../shared/update'

let emit: ((event: UpdateEvent) => void) | null = null
export function setUpdateEventSink(fn: (event: UpdateEvent) => void): void {
  emit = fn
}

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing'

let phase: UpdatePhase = 'idle'
let latestVersion = ''
let checkPromise: Promise<UpdateCheckResult> | null = null
let downloadPromise: Promise<string[]> | null = null
let lastInstallError = ''

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

function handleUpdaterError(error: unknown): void {
  const failedStage = phase === 'downloading' ? 'download' : phase === 'installing' ? 'install' : null
  if (!failedStage) return
  const message = errorMessage(error)
  if (failedStage === 'install') lastInstallError = message
  phase = failedStage === 'download' ? 'available' : 'downloaded'
  emit?.({
    kind: 'error',
    stage: failedStage,
    message,
    version: latestVersion || undefined
  })
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.on('download-progress', (progress) => {
    if (phase !== 'downloading') return
    const percent = Math.min(100, Math.max(0, Number.isFinite(progress.percent) ? progress.percent : 0))
    emit?.({ kind: 'progress', percent, version: latestVersion })
  })
  autoUpdater.on('update-downloaded', (info) => {
    if (phase !== 'downloading') return
    latestVersion = info.version || latestVersion
    phase = 'downloaded'
    emit?.({ kind: 'downloaded', version: latestVersion })
  })
  autoUpdater.on('error', handleUpdaterError)
}

// 数字段逐位比较：'0.7.18' vs '0.10.2'；非数字段按 0 处理
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  // 开发模式没有 app-update.yml，electron-updater 直接报错，明确提示
  if (!app.isPackaged) return { status: 'error', current, error: 'dev' }
  wire()

  if (phase === 'available') return { status: 'update', current, latest: latestVersion }
  if (phase === 'downloaded') return { status: 'downloaded', current, latest: latestVersion }
  if (phase === 'checking' || phase === 'downloading' || phase === 'installing') {
    return { status: 'busy', current, latest: latestVersion || undefined }
  }

  phase = 'checking'
  checkPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      const latest = result?.updateInfo?.version
      if (latest && cmpVersion(latest, current) > 0) {
        latestVersion = latest
        phase = 'available'
        return { status: 'update', current, latest } as const
      }
      latestVersion = latest ?? ''
      phase = 'idle'
      return { status: 'latest', current, latest: latest ?? undefined } as const
    } catch (error) {
      phase = 'idle'
      const message = errorMessage(error)
      // 404：仓库私有或还没发过 Release（latest.yml 拿不到同理）
      const notfound = /404|not\s*found|latest\.yml/i.test(message)
      return { status: 'error', current, error: notfound ? 'notfound' : 'network' } as const
    }
  })()

  try {
    return await checkPromise
  } finally {
    checkPromise = null
  }
}

export function startUpdateDownload(): UpdateActionResult {
  wire()
  if (phase === 'downloading' || phase === 'installing') return { ok: false, error: 'busy' }
  if (phase !== 'available' || !latestVersion) return { ok: false, error: 'not-ready' }

  phase = 'downloading'
  emit?.({ kind: 'progress', percent: 0, version: latestVersion })
  try {
    const pending = autoUpdater.downloadUpdate()
    downloadPromise = pending
    void pending
      .catch((error) => handleUpdaterError(error))
      .finally(() => {
        if (downloadPromise === pending) downloadPromise = null
      })
    return { ok: true }
  } catch (error) {
    handleUpdaterError(error)
    return { ok: false, error: 'failed', message: errorMessage(error) }
  }
}

// isSilent=false 不传 NSIS /S，安装阶段显示 assisted 安装器；autoRunAppAfterInstall 负责安装后拉起应用。
export function quitAndInstallUpdate(beforeInstall?: () => void): UpdateActionResult {
  wire()
  if (phase === 'installing') return { ok: false, error: 'busy' }
  if (phase !== 'downloaded') return { ok: false, error: 'not-ready' }

  phase = 'installing'
  lastInstallError = ''
  try {
    beforeInstall?.()
    autoUpdater.quitAndInstall(false, true)
    // electron-updater 无法启动安装器时会同步触发 error 事件，并把阶段退回 downloaded。
    return lastInstallError
      ? { ok: false, error: 'failed', message: lastInstallError }
      : { ok: true }
  } catch (error) {
    handleUpdaterError(error)
    return { ok: false, error: 'failed', message: errorMessage(error) }
  }
}
