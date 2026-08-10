// 主进程 JSONL 应用日志：一行一条 `{ts, ev, ...data}`，同步追加写（防崩溃丢日志）、
// 按天滚动、保留 7 天。sentinel 文件用于检测上次是否非正常退出。

import { app } from 'electron'
import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 7
const HEARTBEAT_MS = 60_000

function logsDir(): string {
  return app.getPath('logs')
}

function sentinelPath(): string {
  return join(logsDir(), 'running.sentinel')
}

// 按本地时区日期滚动
function today(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fileForDay(day: string): string {
  return join(logsDir(), `app-${day}.jsonl`)
}

let currentDay = ''
let heartbeatTimer: NodeJS.Timeout | null = null
let started = false

// 写一条事件。失败静默 —— 日志系统本身不能反过来把 app 搞崩。
export function logEvent(ev: string, data?: Record<string, unknown>): void {
  try {
    const day = today()
    if (day !== currentDay) currentDay = day
    const line = JSON.stringify({ ts: new Date().toISOString(), ev, ...(data ?? {}) }) + '\n'
    appendFileSync(fileForDay(day), line, 'utf8')
  } catch {
    // 日志失败静默，不影响主流程
  }
}

// 启动时：建目录、清老日志、检查并重写 sentinel、落 start 事件。返回上次是否 unclean。
export function startLogging(meta: { appVersion: string; electron: string; platform: string }): { uncleanExit: boolean } {
  if (started) return { uncleanExit: false }
  started = true

  try { mkdirSync(logsDir(), { recursive: true }) } catch {}
  cleanupOldFiles()

  const sen = sentinelPath()
  const uncleanExit = existsSync(sen)
  logEvent('start', {
    unclean_exit: uncleanExit,
    pid: process.pid,
    ...meta,
    rss: process.memoryUsage().rss
  })
  try {
    writeFileSync(sen, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
  } catch {}

  // 心跳带 rss，日志断点即可锁定进程死亡时间窗口；unref 避免阻止 app 退出
  heartbeatTimer = setInterval(() => {
    logEvent('heartbeat', { rss: process.memoryUsage().rss })
  }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  return { uncleanExit }
}

// 正常退出：落 stop、删 sentinel。
export function stopLogging(reason: string, extra?: Record<string, unknown>): void {
  if (!started) return
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  logEvent('stop', { reason, ...(extra ?? {}) })
  try { unlinkSync(sentinelPath()) } catch {}
  started = false
}

// 清理超过 KEEP_DAYS 的 app-*.jsonl（只按前缀匹配自己写的文件）
function cleanupOldFiles(): void {
  try {
    const dir = logsDir()
    if (!existsSync(dir)) return
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('app-') || !name.endsWith('.jsonl')) continue
      const p = join(dir, name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {}
    }
  } catch {}
}
