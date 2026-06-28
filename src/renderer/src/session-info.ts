import { escapeHtml } from './ui-helpers'

// 与 preload SessionUsage 对齐（renderer 不跨进程 import）
interface SessionUsage {
  exists: boolean
  model?: string
  modelLabel?: string
  ctxTokens?: number
  ctxWindow?: number
  ctxPercent?: number
  ctxApprox?: boolean
}

export interface SessionInfoHooks {
  // 当前激活标签的会话 id 与所在分组 cwd；无激活标签返回 null
  getActive(): { sessionId: string | null; cwd: string } | null
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

  constructor(private hooks: SessionInfoHooks) {
    this.timer = window.setInterval(() => void this.poll(), TICK_MS)
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
      parts.push(
        `<span class="sbi-ctx"${tip}>ctx` +
          `<span class="sbi-ctx-track"><i class="sbi-ctx-fill ${lv}" style="width:${p}%"></i></span>` +
          `<span class="sbi-ctx-val ${lv}">${p}%</span>` +
          `</span>`
      )
      const model = u?.modelLabel ?? this.stickyModel ?? 'Claude'
      parts.push(`<span class="sbi-model">${escapeHtml(model)}</span>`)
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
