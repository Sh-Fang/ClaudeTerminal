// 主进程 JSONL 应用日志：一行一条 `{ts, ev, ...data}`，追加写、按天滚动、保留 7 天。
// 用途：诊断"电脑休眠 → 唤醒后 app 消失"这类只能靠事件时间线还原的故障。
//
// 关键设计：
//  · 同步 appendFileSync —— 崩溃 / 强杀发生在下一次事件循环之前时，异步 write
//    可能来不及 flush 就丢；同步写保证事件一到日志盘上一条。心跳 60s / 常规
//    事件不算频繁，性能可忽略。
//  · sentinel 文件：启动时若已存在 → 上次没走正常退出（崩溃、被 kill、断电、
//    Windows 关机没等我们）；正常退出流程会删掉它。启动那条事件同时落
//    `unclean_exit: true/false` 供事后过滤。
//  · 日期滚动无独立 timer：写之前对比当前日期，跨天就重开文件；无写入的日子
//    根本不用滚动。
//  · 清理只在启动时执行一次 —— app 一般不常驻多天，这个粒度够用；即便真挂了
//    好几天，也只是多几条老日志，不会撑爆。

import { app } from 'electron'
import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 7
const HEARTBEAT_MS = 60_000

// 日志目录：Electron 的 logs path 默认就是 userData/logs，语义明确。
function logsDir(): string {
  return app.getPath('logs')
}

function sentinelPath(): string {
  return join(logsDir(), 'running.sentinel')
}

// 用本地时间日期字符串滚动 —— 用户对着自己时区看日志才对齐得上。
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
    // 目录不存在 / 权限问题都吞掉，别拿日志问题去污染诊断
  }
}

// 启动时：建目录、清老日志、检查 sentinel、写 sentinel、落 start 事件。
// 返回上次是否 unclean，供 index.ts 需要时观察（这里也已经落到日志里了）。
export function startLogging(meta: { appVersion: string; electron: string; platform: string }): { uncleanExit: boolean } {
  if (started) return { uncleanExit: false }
  started = true

  try { mkdirSync(logsDir(), { recursive: true }) } catch {}
  cleanupOldFiles()

  const sen = sentinelPath()
  const uncleanExit = existsSync(sen)
  // 无论上次是否干净都要落一条 start，方便按启动分段查阅
  logEvent('start', {
    unclean_exit: uncleanExit,
    pid: process.pid,
    ...meta,
    rss: process.memoryUsage().rss
  })
  // 写新 sentinel —— 里面塞一点信息便于事后判断哪个 pid 崩的
  try {
    writeFileSync(sen, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
  } catch {}

  // 心跳：只带最基本的 rss，能证明进程"这一刻还活着"，日志断点即可锁定死亡时间窗口
  heartbeatTimer = setInterval(() => {
    logEvent('heartbeat', { rss: process.memoryUsage().rss })
  }, HEARTBEAT_MS)
  // Node 会以最后一个未 unref 的 timer 为由留驻事件循环；心跳不该阻止 app 退出
  heartbeatTimer.unref?.()

  return { uncleanExit }
}

// 正常退出路径：落 stop、删 sentinel。stop 之后就别再写了。
export function stopLogging(reason: string, extra?: Record<string, unknown>): void {
  if (!started) return
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  logEvent('stop', { reason, ...(extra ?? {}) })
  try { unlinkSync(sentinelPath()) } catch {}
  started = false
}

// 保留 KEEP_DAYS 天，按 mtime 排序清理超期的 app-*.jsonl。
// 只清自己写的文件（前缀匹配）—— 别乱删同目录下别人放的东西。
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
