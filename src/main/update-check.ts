// 应用内更新：electron-updater 走 GitHub Releases 的 latest.yml。
// 检查到新版本即自动开始下载（下载进度/完成经事件回推渲染层）；下载完成后
// 用户可立即静默安装重启，不点的话退出应用时也会静默装上（autoInstallOnAppQuit）。
// 仓库私有/尚无 Release 时 API 是 404，归类为 notfound 由 UI 提示「暂无可用的发布版本」。
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export interface UpdateCheckResult {
  status: 'latest' | 'update' | 'error'
  current: string
  latest?: string
  error?: 'network' | 'notfound' | 'dev'
}

export type UpdateEvent =
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

let emit: ((e: UpdateEvent) => void) | null = null
export function setUpdateEventSink(fn: (e: UpdateEvent) => void): void {
  emit = fn
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('download-progress', (p) => emit?.({ kind: 'progress', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => emit?.({ kind: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => emit?.({ kind: 'error', message: String(err?.message ?? err) }))
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
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r?.updateInfo?.version
    if (latest && cmpVersion(latest, current) > 0) return { status: 'update', current, latest }
    return { status: 'latest', current, latest: latest ?? undefined }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // 404：仓库私有或还没发过 Release（latest.yml 拿不到同理）
    const notfound = /404|not\s*found|latest\.yml/i.test(msg)
    return { status: 'error', current, error: notfound ? 'notfound' : 'network' }
  }
}

// 静默安装并重启（isSilent=true 走 NSIS /S，不弹安装向导）
export function quitAndInstallUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
