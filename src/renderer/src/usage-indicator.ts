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

function pct(w?: UsageWindow): number {
  return w && Number.isFinite(w.utilization) ? Math.round(w.utilization) : 0
}

function lvOf(p: number): string {
  if (p >= 90) return 'lv-danger'
  if (p >= 70) return 'lv-warn'
  return 'lv-ok'
}

// 一行 inline：label · 进度条 · 百分比 · 重置时间，跟底部状态栏 ctx 同款排版
function bar(label: string, percent: number, reset: string): string {
  const lv = lvOf(percent)
  return (
    `<span class="ubar">` +
    `<span class="ubar-label">${label}</span>` +
    `<span class="ubar-track"><i class="ubar-fill ${lv}" style="width:${percent}%"></i></span>` +
    `<span class="ubar-val ${lv}">${percent}%</span>` +
    (reset ? `<span class="ubar-reset">${reset}</span>` : '') +
    `</span>`
  )
}

// 圆环：SVG 双圆（底轨 + 按百分比截断的进度弧），中心是百分比。
// 横向排布：左侧圆环，右侧两行文字（标题 / 重置倒计时）。
const RING_R = 15.5
const RING_C = 2 * Math.PI * RING_R
function ring(label: string, percent: number, reset: string): string {
  const lv = lvOf(percent)
  const offset = (RING_C * (100 - Math.min(100, Math.max(0, percent)))) / 100
  return (
    `<span class="uring">` +
    `<span class="uring-box">` +
    `<svg viewBox="0 0 40 40" aria-hidden="true">` +
    `<circle class="uring-track" cx="20" cy="20" r="${RING_R}"></circle>` +
    `<circle class="uring-fill ${lv}" cx="20" cy="20" r="${RING_R}" ` +
    `stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" ` +
    `transform="rotate(-90 20 20)"></circle>` +
    `</svg>` +
    `<span class="uring-val ${lv}">${percent}%</span>` +
    `</span>` +
    `<span class="uring-meta">` +
    `<span class="uring-label">${label}</span>` +
    `<span class="uring-reset">${reset}</span>` +
    `</span>` +
    `</span>`
  )
}

export type UsageStyle = 'bar' | 'ring'

export class UsageIndicator {
  private panel = document.getElementById('usagePanel') as HTMLElement
  private el = document.getElementById('usageBars') as HTMLDivElement
  private pollTimer: number | null = null
  private tickTimer: number | null = null
  private enabled = false
  private style: UsageStyle = 'bar'
  private last: ClaudeUsage | null = null

  applySettings(enabled: boolean, style: UsageStyle = 'bar'): void {
    const styleChanged = style !== this.style
    this.style = style
    if (enabled === this.enabled) {
      // 开关没变但样式变了 → 原地重绘
      if (enabled && styleChanged) this.paint()
      return
    }
    this.enabled = enabled
    if (enabled) this.start()
    else this.stop()
  }

  private start(): void {
    this.panel.hidden = false
    this.el.className = 'usage-bars loading'
    this.el.textContent = 'Claude 用量…'
    void this.refresh(true)
    this.pollTimer = window.setInterval(() => void this.refresh(false), POLL_MS)
    this.tickTimer = window.setInterval(() => this.paint(), TICK_MS)
  }

  private stop(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer)
    if (this.tickTimer) window.clearInterval(this.tickTimer)
    this.pollTimer = this.tickTimer = null
    this.last = null
    this.panel.hidden = true
    this.el.className = 'usage-bars'
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
      this.el.className = 'usage-bars error'
      this.el.textContent = 'Claude 用量 ✕'
    }
  }

  private paint(): void {
    const u = this.last
    if (!u) return
    if (!u.ok) {
      this.el.className = 'usage-bars error'
      this.el.textContent = 'Claude 用量 ✕'
      this.el.title = u.error || '获取失败'
      return
    }
    const five = pct(u.fiveHour)
    const week = pct(u.sevenDay)
    const fiveReset = fmtCountdown(u.fiveHour?.resetsAt ?? null)
    const weekReset = fmtCountdown(u.sevenDay?.resetsAt ?? null)
    this.el.title = ''
    if (this.style === 'ring') {
      // 圆环样式：5h 额度和本周额度左右并排
      this.el.className = 'usage-bars is-rings'
      this.el.innerHTML = ring('5h额度', five, fiveReset) + ring('本周额度', week, weekReset)
    } else {
      this.el.className = 'usage-bars'
      this.el.innerHTML = bar('5h额度', five, fiveReset) + bar('本周额度', week, weekReset)
    }
  }
}
