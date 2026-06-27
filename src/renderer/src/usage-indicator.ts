// 与 preload 的 ClaudeUsage 对齐（renderer 不跨进程 import，本地镜像一份）
interface UsageWindow {
  utilization: number
  resetsAt: string | null
}
interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayOpus?: UsageWindow | null
  sevenDaySonnet?: UsageWindow | null
  fetchedAt: number
}

const POLL_MS = 180_000 // 与主进程缓存一致：每 3 分钟拉一次
const TICK_MS = 30_000 // 重置倒计时文案每 30s 刷新一次（不发请求）

// 把毫秒差格式化成紧凑倒计时：3d20h / 4h13m / 12m / <1m
function fmtCountdown(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return '即将重置'
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d${h % 24}h`
  if (h > 0) return `${h}h${m % 60}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

function fmtClock(resetsAt: string | null): string {
  if (!resetsAt) return '—'
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pct(w?: UsageWindow): number {
  return w && Number.isFinite(w.utilization) ? Math.round(w.utilization) : 0
}

// 用量展示由 5h / 周 两个窗口里更高的那个决定颜色档位
function levelClass(u: ClaudeUsage): string {
  const max = Math.max(pct(u.fiveHour), pct(u.sevenDay))
  if (max >= 90) return 'lv-danger'
  if (max >= 70) return 'lv-warn'
  return 'lv-ok'
}

export class UsageIndicator {
  private el = document.getElementById('sbUsage') as HTMLSpanElement
  private pollTimer: number | null = null
  private tickTimer: number | null = null
  private enabled = false
  private last: ClaudeUsage | null = null

  applySettings(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) this.start()
    else this.stop()
  }

  private start(): void {
    this.el.hidden = false
    this.el.className = 'sb-usage loading'
    this.el.textContent = 'Claude 用量…'
    this.el.title = '正在获取…'
    void this.refresh(true)
    this.pollTimer = window.setInterval(() => void this.refresh(false), POLL_MS)
    this.tickTimer = window.setInterval(() => this.paint(), TICK_MS)
  }

  private stop(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer)
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.pollTimer = this.tickTimer = null
    this.last = null
    this.el.hidden = true
    this.el.textContent = ''
    this.el.title = ''
  }

  private async refresh(force: boolean): Promise<void> {
    try {
      const u = await window.term.claudeUsage(force)
      if (!this.enabled) return
      this.last = u
      this.paint()
    } catch {
      if (!this.enabled) return
      this.el.className = 'sb-usage error'
      this.el.textContent = 'Claude 用量 ✕'
      this.el.title = '获取失败'
    }
  }

  private paint(): void {
    const u = this.last
    if (!u) return
    if (!u.ok) {
      this.el.className = 'sb-usage error'
      this.el.textContent = 'Claude 用量 ✕'
      this.el.title = u.error || '获取失败'
      return
    }
    const five = pct(u.fiveHour)
    const week = pct(u.sevenDay)
    const weekReset = fmtCountdown(u.sevenDay?.resetsAt ?? null)
    this.el.className = `sb-usage ${levelClass(u)}`
    this.el.textContent = `周 ${week}% · 5h ${five}%${weekReset ? ` · 重置 ${weekReset}` : ''}`

    const lines = [
      `5 小时窗口：${five}%　重置 ${fmtCountdown(u.fiveHour?.resetsAt ?? null) || '—'}（${fmtClock(u.fiveHour?.resetsAt ?? null)}）`,
      `7 天窗口：${week}%　重置 ${weekReset || '—'}（${fmtClock(u.sevenDay?.resetsAt ?? null)}）`
    ]
    if (u.sevenDaySonnet) lines.push(`Sonnet 周：${pct(u.sevenDaySonnet)}%`)
    if (u.sevenDayOpus) lines.push(`Opus 周：${pct(u.sevenDayOpus)}%`)
    lines.push(`更新于 ${fmtClock(new Date(u.fetchedAt).toISOString())}`)
    this.el.title = lines.join('\n')
  }
}
