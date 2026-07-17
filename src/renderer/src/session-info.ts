import { escapeHtml, showCtxMenu } from './ui-helpers'

// 左下角模型芯片的候选：按家族分组、每组列具体版本。
// ── 维护点 ──：模型上新 / 退役时改这里。
//   arg = 注入给 `/model` 的实参：家族"最新"用 alias（稳，永远指向最新）；要钉具体
//   旧版本用完整 model id（可能随退役失效 —— 选到退役版 cc 会在终端自己报错，这是刻意
//   的兜底，不拦）。match = 用当前展示的模型名（小写）子串匹配，给当前项打勾。
export interface ModelRow { label: string; arg: string; match: string }
export const MODEL_GROUPS: { family: string; rows: ModelRow[] }[] = [
  { family: 'Opus', rows: [
    { label: 'Opus 4.8', arg: 'claude-opus-4-8', match: 'opus 4.8' },
    { label: 'Opus 4.7', arg: 'claude-opus-4-7', match: 'opus 4.7' },
    { label: 'Opus 4.6', arg: 'claude-opus-4-6', match: 'opus 4.6' }
  ] },
  { family: 'Sonnet', rows: [
    { label: 'Sonnet 4.6', arg: 'claude-sonnet-4-6', match: 'sonnet 4.6' },
    { label: 'Sonnet 4.5', arg: 'claude-sonnet-4-5', match: 'sonnet 4.5' }
  ] },
  { family: 'Haiku', rows: [
    { label: 'Haiku 4.5', arg: 'haiku', match: 'haiku' }
  ] },
  { family: 'Fable', rows: [
    { label: 'Fable 5', arg: 'fable', match: 'fable' }
  ] }
]

// 思考强度候选。max 是 session-only；cc 仅在模型支持 effort 时上报，故芯片会自动隐藏。
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']

// 与 preload SessionUsage 对齐（renderer 不跨进程 import）
interface SessionUsage {
  exists: boolean
  model?: string
  modelLabel?: string
  effort?: string
  ctxTokens?: number
  ctxWindow?: number
  ctxPercent?: number
  ctxApprox?: boolean
}

export interface SessionInfoHooks {
  // 当前激活标签的会话 id 与所在分组 cwd；无激活标签返回 null
  getActive(): { sessionId: string | null; cwd: string } | null
  // 用户在模型菜单选了某一行 → 注入 `/model <arg>`（arg 为 alias 或完整 id），label 供 toast
  requestModelSwitch(arg: string, label: string): void
  // 用户在 effort 菜单选了某档 → 注入 `/effort <level>`
  requestEffortSwitch(level: string): void
}

const TICK_MS = 3000 // 上下文会随对话增长，每 3s 刷新一次
const BRANCH_EVERY = 7 // 分支变动少，约每 21s 才重查一次（切换时立即查）

// lucide git-branch 图标，比 ⎇ 字符更直观
const BRANCH_ICON =
  '<svg class="sbi-branch-ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>'

function ctxLevel(p: number): string {
  if (p >= 90) return 'lv-danger'
  if (p >= 70) return 'lv-warn'
  return 'lv-ok'
}

// 把 git/cc 来的文本做长度保护 + 转义
function clip(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// 首字母大写：effort 档位展示用（low → Low）。注入命令仍用原始小写。
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

export class SessionInfoBar {
  private el = document.getElementById('sbSession') as HTMLSpanElement
  private lastKey = ''
  private branch: string | null = null
  private usage: SessionUsage | null = null
  // 上一次成功拿到的模型名。新会话/刚切换会话时 cc 还没上报 usage，用它兜底
  // 避免状态栏空一段。cc 进程内默认模型很少切，所以基本是准确的。
  private stickyModel: string | null = null
  private tick = 0
  private polling = false
  private timer: number | null = null
  // 额度显示样式联动：'ring' 时 ctx 也画成迷你圆环（尺寸缩到状态栏行高内，不撑高底栏）
  private usageStyle: 'bar' | 'ring' = 'bar'

  setUsageStyle(style: 'bar' | 'ring'): void {
    if (style === this.usageStyle) return
    this.usageStyle = style
    this.paint()
  }

  constructor(private hooks: SessionInfoHooks) {
    this.timer = window.setInterval(() => void this.poll(), TICK_MS)
    // 事件委托：paint 每次重写 innerHTML 会冲掉直接绑定的监听，故绑在常驻容器上。
    // stopPropagation 挡掉 ui-helpers 里"点空白关菜单"的 document handler，否则刚开就被关。
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const modelChip = t.closest('.sbi-model') as HTMLElement | null
      if (modelChip) { e.stopPropagation(); this.openModelMenu(modelChip); return }
      const effChip = t.closest('.sbi-effort') as HTMLElement | null
      if (effChip) { e.stopPropagation(); this.openEffortMenu(effChip) }
    })
  }

  private openModelMenu(anchor: HTMLElement): void {
    const cur = (this.usage?.modelLabel ?? this.stickyModel ?? '').toLowerCase()
    const r = anchor.getBoundingClientRect()
    // y 传芯片顶部；showCtxMenu 会把菜单夹在视口内，芯片贴底时自动向上弹。
    // 各家族之间插分隔线；当前项按 match 子串命中打勾。
    showCtxMenu(
      MODEL_GROUPS.flatMap((g, gi) => [
        ...(gi > 0 ? [{ sep: true }] : []),
        ...g.rows.map((row) => ({
          label: row.label,
          icon: cur.includes(row.match) ? '✓' : '',
          act: () => this.hooks.requestModelSwitch(row.arg, row.label)
        }))
      ]),
      r.left,
      r.top
    )
  }

  private openEffortMenu(anchor: HTMLElement): void {
    const cur = (this.usage?.effort ?? '').toLowerCase()
    const r = anchor.getBoundingClientRect()
    // 菜单从上到下高→低：顶部 max、底部 low（EFFORT_OPTIONS 本身是低→高，渲染时倒序）
    showCtxMenu(
      [...EFFORT_OPTIONS].reverse().map((lv) => ({
        label: cap(lv),
        icon: lv === cur ? '✓' : '',
        act: () => this.hooks.requestEffortSwitch(lv)
      })),
      r.left,
      r.top
    )
  }

  // 切换标签 / 会话时主动催一次，立即刷新（不等下个 tick）
  nudge(): void {
    void this.poll()
  }

  dispose(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    // 并发护栏：poll 内部 await 两个 IPC，慢仓库下可能跨过下个 tick。若不挡，
    // 多个 poll 重叠执行会互相覆盖 branch/usage/tick，导致闪烁与陈旧数据。
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    const a = this.hooks.getActive()
    if (!a) {
      this.lastKey = ''
      this.branch = null
      this.usage = null
      this.el.hidden = true
      return
    }
    const key = `${a.sessionId ?? ''}::${a.cwd}`
    const changed = key !== this.lastKey
    if (changed) {
      this.lastKey = key
      this.tick = 0
      this.branch = null
      this.usage = null
    }
    try {
      if (changed || this.tick % BRANCH_EVERY === 0) {
        this.branch = a.cwd ? await window.term.gitBranch(a.cwd) : null
      }
      if (a.sessionId) {
        const u = await window.term.claudeSessionUsage(a.sessionId)
        this.usage = u.exists ? u : null
        if (u.exists && u.modelLabel) this.stickyModel = u.modelLabel
      } else {
        this.usage = null
      }
    } catch {
      // 单次失败忽略，下个 tick 再来
    }
    this.tick++
    // poll 期间用户可能又切了；只在仍是同一目标时绘制，避免串台
    const now = this.hooks.getActive()
    if (now && `${now.sessionId ?? ''}::${now.cwd}` === key) this.paint()
  }

  private paint(): void {
    const parts: string[] = []
    const u = this.usage
    const a = this.hooks.getActive()
    const hasActive = !!a?.sessionId
    // 顺序：ctx（进度条）· 模型 · git 分支
    // 只要有 active session 就展示 ctx 与模型骨架——新会话 cc 还没上报时也不能空着，
    // ctx 默认 0%，模型用 stickyModel 兜底（同一 cc 进程默认模型通常不变），
    // 都没有再退到占位 "Claude"。
    if (hasActive) {
      const hasCtx = u && typeof u.ctxPercent === 'number'
      const p = hasCtx ? (u!.ctxPercent as number) : 0
      const lv = ctxLevel(p)
      const tip = hasCtx && u!.ctxTokens != null
        ? ` title="上下文 ${u!.ctxTokens!.toLocaleString()} / ${(u!.ctxWindow ?? 0).toLocaleString()} tokens${u!.ctxApprox ? '（窗口为估算，未读到会话快照）' : ''}"`
        : ' title="新会话，等待 cc 上报上下文用量"'
      if (this.usageStyle === 'ring') {
        // 迷你圆环：13px 视觉尺寸贴合状态栏行高，绝不撑高底栏
        const R = 6
        const C = 2 * Math.PI * R
        const off = (C * (100 - Math.min(100, Math.max(0, p)))) / 100
        parts.push(
          `<span class="sbi-ctx"${tip}>ctx` +
            `<svg class="sbi-ctx-ring" viewBox="0 0 16 16" aria-hidden="true">` +
            `<circle class="ring-track" cx="8" cy="8" r="${R}"></circle>` +
            `<circle class="ring-fill ${lv}" cx="8" cy="8" r="${R}" ` +
            `stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" ` +
            `transform="rotate(-90 8 8)"></circle>` +
            `</svg>` +
            `<span class="sbi-ctx-val ${lv}">${p}%</span>` +
            `</span>`
        )
      } else {
        parts.push(
          `<span class="sbi-ctx"${tip}>ctx` +
            `<span class="sbi-ctx-track"><i class="sbi-ctx-fill ${lv}" style="width:${p}%"></i></span>` +
            `<span class="sbi-ctx-val ${lv}">${p}%</span>` +
            `</span>`
        )
      }
      const model = u?.modelLabel ?? this.stickyModel ?? 'Claude'
      parts.push(
        `<span class="sbi-model" title="点击切换模型">${escapeHtml(model)}</span>`
      )
      // effort 芯片：仅在 cc 上报了 effort（模型支持思考强度）时展示，夹在模型与 git 分支之间。
      const eff = u?.effort
      if (eff)
        parts.push(
          `<span class="sbi-effort" title="点击切换思考强度 (effort)">${escapeHtml(cap(eff))}</span>`
        )
    }
    if (this.branch)
      parts.push(
        `<span class="sbi-branch" title="${escapeHtml(this.branch)}">${BRANCH_ICON}<span class="sbi-branch-name">${escapeHtml(clip(this.branch, 48))}</span></span>`
      )
    if (parts.length === 0) {
      this.el.hidden = true
      this.el.innerHTML = ''
      return
    }
    this.el.hidden = false
    this.el.innerHTML = parts.join('<span class="sbi-sep">·</span>')
  }
}
