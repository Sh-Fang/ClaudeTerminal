import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '../state/store'
import { getSettings } from '../controller'
import { t } from '../i18n'

// 与 preload 的 ClaudeUsage 对齐（renderer 不跨进程 import，本地镜像一份）
interface UsageWindow {
  utilization: number
  resetsAt: string | null
  scopeLabel?: string // 周额度按模型拆分时的模型名（如 'Fable'）；无 = 账号级总额度
}
interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayModel?: UsageWindow | null // 模型级周额度（如 Fable），主条是总池时用于 hover 展示
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
  if (ms <= 0) return t('即将重置')
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

// 一行 inline：label · 进度条 · 百分比 · 重置时间，跟底部状态栏 ctx 同款排版。
// percent 为 null = 最终没拿到数据 → 空轨 + 横杠占位（区别于真实 0%）。
// weekly=true 时打 data-weekly 标记（CSS 靠它做 hover 弹模型额度卡片）。
function bar(label: string, percent: number | null, reset: string, weekly = false, key?: string): ReactNode {
  const has = typeof percent === 'number'
  const lv = has ? lvOf(percent as number) : 'lv-none'
  return (
    <span key={key} className="ubar" {...(weekly ? { 'data-weekly': '' } : {})}>
      <span className="ubar-label">{label}</span>
      <span className="ubar-track">
        <i className={`ubar-fill ${lv}`} style={{ width: `${has ? percent : 0}%` }} />
      </span>
      <span className={`ubar-val ${lv}`}>{has ? `${percent}%` : '—'}</span>
      {reset ? <span className="ubar-reset">{reset}</span> : null}
    </span>
  )
}

// 圆环：SVG 双圆（底轨 + 按百分比截断的进度弧），中心是百分比。
// 横向排布：左侧圆环，右侧两行文字（标题 / 重置倒计时）。
const RING_R = 15.5
const RING_C = 2 * Math.PI * RING_R
function ring(label: string, percent: number | null, reset: string, weekly = false, key?: string): ReactNode {
  const has = typeof percent === 'number'
  const p = has ? Math.min(100, Math.max(0, percent as number)) : 0
  const lv = has ? lvOf(percent as number) : 'lv-none'
  const offset = (RING_C * (100 - p)) / 100
  return (
    <span key={key} className="uring" {...(weekly ? { 'data-weekly': '' } : {})}>
      <span className="uring-box">
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <circle className="uring-track" cx="20" cy="20" r={RING_R} />
          <circle
            className={`uring-fill ${lv}`}
            cx="20"
            cy="20"
            r={RING_R}
            strokeDasharray={RING_C.toFixed(2)}
            strokeDashoffset={offset.toFixed(2)}
            transform="rotate(-90 20 20)"
          />
        </svg>
        <span className={`uring-val ${lv}`}>{has ? `${p}%` : '—'}</span>
      </span>
      <span className="uring-meta">
        <span className="uring-label">{label}</span>
        <span className="uring-reset">{reset}</span>
      </span>
    </span>
  )
}

export function UsagePanel() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const settings = getSettings()
  const show = settings.showClaudeUsage
  const style = settings.usageStyle || 'bar'

  const [last, setLast] = useState<ClaudeUsage | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false) // IPC 本身抛异常（区别于 last.ok=false）
  const [, setTickN] = useState(0) // 只为让倒计时文案每 30s 重算一次，无请求

  // 开关驱动的拉取生命周期：show=true 起两只定时器，关掉/卸载时清理并清空数据
  // （对应原 start()/stop()；样式切换不进 effect——render 本身就是原 paint()，rev 一变即重绘）。
  useEffect(() => {
    if (!show) return
    let alive = true
    // 非 force：快照/新鲜缓存(180s)直接秒显，过期或没有才真拉 —— 反复开关不重复打接口，
    // 也不会无视失败冷却硬打；首次无缓存时仍会立即拉。
    const refresh = async (force: boolean): Promise<void> => {
      try {
        const u = await window.term.claudeUsage(force)
        if (!alive) return
        setLast(u)
        setFetchFailed(false)
      } catch {
        if (!alive) return
        setFetchFailed(true)
      }
    }
    void refresh(false)
    const pollTimer = window.setInterval(() => void refresh(false), POLL_MS)
    const tickTimer = window.setInterval(() => setTickN((n) => n + 1), TICK_MS)
    return () => {
      alive = false
      window.clearInterval(pollTimer)
      window.clearInterval(tickTimer)
      // 对齐原 stop()：关闭即丢弃数据，下次打开重新走缓存/拉取
      setLast(null)
      setFetchFailed(false)
    }
  }, [show])

  // ── paint ──
  let cls = 'usage-bars'
  let title = ''
  let content: ReactNode = null
  if (show) {
    if (last && last.ok) {
      const u = last
      const render = style === 'ring' ? ring : bar
      const items: ReactNode[] = []
      // 5h 缺失才跳过；本周额度始终渲染，最终没拿到就传 null → 显示横杠占位（区别于真实 0%）
      if (u.fiveHour) items.push(render(t('5h额度'), pct(u.fiveHour), fmtCountdown(u.fiveHour.resetsAt), false, '5h'))
      // 周额度主条：账号级总池 → 「本周额度」；没有总池、只有模型专属配额（如 Fable）→ 「Fable额度」；
      // 彻底没拿到 → 仍用「本周额度」显示横杠占位。
      const weeklyLabel = u.sevenDay?.scopeLabel ? t('{0}额度', u.sevenDay.scopeLabel) : t('本周额度')
      // hover 卡片：仅当主条是账号总池（无 scopeLabel）且另有模型级配额时，悬浮补显模型额度。
      // 主条本身就是模型级（总池缺失退回 Fable）时不再重复展示，模型级缺失则 hover 无反应。
      const model = (u.sevenDay && !u.sevenDay.scopeLabel && u.sevenDayModel) || null
      items.push(
        u.sevenDay
          ? render(weeklyLabel, pct(u.sevenDay), fmtCountdown(u.sevenDay.resetsAt), !!model, '7d')
          : render(t('本周额度'), null, '', false, '7d')
      )
      if (model) {
        items.push(
          <div key="pop" className="usage-pop">
            {render(t('{0}额度', model.scopeLabel ?? ''), pct(model), fmtCountdown(model.resetsAt))}
          </div>
        )
      }
      cls = style === 'ring' ? 'usage-bars is-rings' : 'usage-bars'
      content = items
    } else if (last && !last.ok) {
      cls = 'usage-bars error'
      title = t(last.error || '获取失败')
      content = t('Claude 用量 ✕')
    } else if (fetchFailed) {
      cls = 'usage-bars error'
      content = t('Claude 用量 ✕')
    } else {
      cls = 'usage-bars loading'
      content = t('Claude 用量…')
    }
  }

  return (
    <section className="side-usage" id="usagePanel" hidden={!show}>
      <div id="usageBars" className={cls} title={title}>
        {content}
      </div>
    </section>
  )
}
