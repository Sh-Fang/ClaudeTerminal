import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '../state/store'
import { busOn } from '../state/bus'
import { showCtxMenu, toast } from '../state/overlays'
import { getSessionInfoCtx, getSettings, switchActiveModel, switchActiveEffort } from '../controller'
import { t } from '../i18n'

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

const TICK_MS = 3000 // 上下文会随对话增长，每 3s 刷新一次
const BRANCH_EVERY = 7 // 分支变动少，约每 21s 才重查一次（切换时立即查）

function ctxLevel(p: number): string {
  if (p >= 90) return 'lv-danger'
  if (p >= 70) return 'lv-warn'
  return 'lv-ok'
}

// 把 git/cc 来的文本做长度保护（JSX 文本节点自带转义，无需 escapeHtml）
function clip(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// 首字母大写：effort 档位展示用（low → Low）。注入命令仍用原始小写。
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

// 一次 poll 的渲染快照：原实现是 poll 完调 paint()，这里等价为 poll 完 setSnap 触发重渲染。
interface Snap {
  hasActive: boolean // 有活跃会话（sessionId 非空）→ 展示 ctx / 模型骨架
  usage: SessionUsage | null
  // 上一次成功拿到的模型名。新会话/刚切换会话时 cc 还没上报 usage，用它兜底
  // 避免状态栏空一段。cc 进程内默认模型很少切，所以基本是准确的。
  stickyModel: string | null
  branch: string | null
}

export function SessionInfoBar() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const [snap, setSnap] = useState<Snap>({ hasActive: false, usage: null, stickyModel: null, branch: null })

  // 轮询 + nudge 订阅。poll 的全部可变状态（lastKey/tick/branch/usage/并发护栏）收在
  // effect 闭包里——生命周期与原 constructor/dispose 一一对应。
  useEffect(() => {
    let lastKey = ''
    let branch: string | null = null
    let usage: SessionUsage | null = null
    let stickyModel: string | null = null
    let tick = 0
    let polling = false

    const pollOnce = async (): Promise<void> => {
      const a = getSessionInfoCtx()
      if (!a) {
        lastKey = ''
        branch = null
        usage = null
        setSnap({ hasActive: false, usage: null, stickyModel, branch: null })
        return
      }
      const key = `${a.sessionId ?? ''}::${a.cwd}`
      const changed = key !== lastKey
      if (changed) {
        lastKey = key
        tick = 0
        branch = null
        usage = null
      }
      try {
        if (changed || tick % BRANCH_EVERY === 0) {
          branch = a.cwd ? await window.term.gitBranch(a.cwd) : null
        }
        if (a.sessionId) {
          const u = await window.term.claudeSessionUsage(a.sessionId)
          usage = u.exists ? u : null
          if (u.exists && u.modelLabel) stickyModel = u.modelLabel
        } else {
          usage = null
        }
      } catch {
        // 单次失败忽略，下个 tick 再来
      }
      tick++
      // poll 期间用户可能又切了；只在仍是同一目标时绘制，避免串台
      const now = getSessionInfoCtx()
      if (now && `${now.sessionId ?? ''}::${now.cwd}` === key) {
        setSnap({ hasActive: !!now.sessionId, usage, stickyModel, branch })
      }
    }

    const poll = async (): Promise<void> => {
      // 并发护栏：poll 内部 await 两个 IPC，慢仓库下可能跨过下个 tick。若不挡，
      // 多个 poll 重叠执行会互相覆盖 branch/usage/tick，导致闪烁与陈旧数据。
      if (polling) return
      polling = true
      try {
        await pollOnce()
      } finally {
        polling = false
      }
    }

    const kick = (): void => void poll()
    const timer = window.setInterval(kick, TICK_MS)
    // 切换标签 / 会话时 controller 会 busEmit 催一次，立即刷新（不等下个 tick）
    const offNudge = busOn('sessionInfo:nudge', kick)
    return () => {
      window.clearInterval(timer)
      offNudge()
    }
  }, [])

  const openModelMenu = (anchor: HTMLElement): void => {
    const cur = (snap.usage?.modelLabel ?? snap.stickyModel ?? '').toLowerCase()
    const r = anchor.getBoundingClientRect()
    // y 传芯片顶部；showCtxMenu 会把菜单夹在视口内，芯片贴底时自动向上弹。
    // 各家族之间插分隔线；当前项按 match 子串命中打勾。
    showCtxMenu(
      MODEL_GROUPS.flatMap((g, gi) => [
        ...(gi > 0 ? [{ sep: true }] : []),
        ...g.rows.map((row) => ({
          label: row.label,
          icon: cur.includes(row.match) ? '✓' : '',
          act: () => switchActiveModel(row.arg, row.label)
        }))
      ]),
      r.left,
      r.top
    )
  }

  const openEffortMenu = (anchor: HTMLElement): void => {
    const cur = (snap.usage?.effort ?? '').toLowerCase()
    const r = anchor.getBoundingClientRect()
    // 菜单从上到下高→低：顶部 max、底部 low（EFFORT_OPTIONS 本身是低→高，渲染时倒序）
    showCtxMenu(
      [...EFFORT_OPTIONS].reverse().map((lv) => ({
        label: cap(lv),
        icon: lv === cur ? '✓' : '',
        act: () => switchActiveEffort(lv)
      })),
      r.left,
      r.top
    )
  }

  // ── paint：由 snap（poll 产物）+ settings（rev 驱动）纯函数式生成 ──
  // 额度显示样式联动：'ring' 时 ctx 也画成迷你圆环（尺寸缩到状态栏行高内，不撑高底栏）
  const usageStyle = getSettings().usageStyle || 'bar'
  const u = snap.usage
  const parts: ReactNode[] = []
  // 顺序：ctx（进度条）· 模型 · git 分支
  // 只要有 active session 就展示 ctx 与模型骨架——新会话 cc 还没上报时也不能空着，
  // ctx 默认 0%，模型用 stickyModel 兜底（同一 cc 进程默认模型通常不变），
  // 都没有再退到占位 "Claude"。
  if (snap.hasActive) {
    const hasCtx = !!(u && typeof u.ctxPercent === 'number')
    const p = hasCtx ? (u!.ctxPercent as number) : 0
    const lv = ctxLevel(p)
    const tip =
      hasCtx && u!.ctxTokens != null
        ? t('上下文 {0} / {1} tokens', u!.ctxTokens!.toLocaleString(), (u!.ctxWindow ?? 0).toLocaleString()) +
          (u!.ctxApprox ? t('（窗口为估算，未读到会话快照）') : '')
        : t('新会话，等待 cc 上报上下文用量')
    if (usageStyle === 'ring') {
      // 迷你圆环：13px 视觉尺寸贴合状态栏行高，绝不撑高底栏
      const R = 6
      const C = 2 * Math.PI * R
      const off = (C * (100 - Math.min(100, Math.max(0, p)))) / 100
      parts.push(
        <span key="ctx" className="sbi-ctx" title={tip}>
          ctx
          <svg className="sbi-ctx-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="ring-track" cx="8" cy="8" r={R} />
            <circle
              className={`ring-fill ${lv}`}
              cx="8"
              cy="8"
              r={R}
              strokeDasharray={C.toFixed(2)}
              strokeDashoffset={off.toFixed(2)}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span className={`sbi-ctx-val ${lv}`}>{p}%</span>
        </span>
      )
    } else {
      parts.push(
        <span key="ctx" className="sbi-ctx" title={tip}>
          ctx
          <span className="sbi-ctx-track">
            <i className={`sbi-ctx-fill ${lv}`} style={{ width: `${p}%` }} />
          </span>
          <span className={`sbi-ctx-val ${lv}`}>{p}%</span>
        </span>
      )
    }
    const model = u?.modelLabel ?? snap.stickyModel ?? 'Claude'
    parts.push(
      <span
        key="model"
        className="sbi-model"
        title={t('点击切换模型')}
        onClick={(e) => {
          // stopPropagation 挡掉 overlays 里"点空白关菜单"的 document handler，否则刚开就被关。
          e.stopPropagation()
          openModelMenu(e.currentTarget)
        }}
      >
        {model}
      </span>
    )
    // effort 芯片：仅在 cc 上报了 effort（模型支持思考强度）时展示，夹在模型与 git 分支之间。
    const eff = u?.effort
    if (eff) {
      parts.push(
        <span
          key="effort"
          className="sbi-effort"
          title={t('点击切换思考强度 (effort)')}
          onClick={(e) => {
            e.stopPropagation()
            openEffortMenu(e.currentTarget)
          }}
        >
          {cap(eff)}
        </span>
      )
    }
  }
  if (snap.branch) {
    parts.push(
      <span key="branch" className="sbi-branch" title={snap.branch}>
        {/* lucide git-branch 图标，比 ⎇ 字符更直观 */}
        <svg
          className="sbi-branch-ic"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="sbi-branch-name">{clip(snap.branch, 48)}</span>
      </span>
    )
  }
  // 各段之间插 · 分隔符
  const children: ReactNode[] = []
  parts.forEach((p, i) => {
    if (i > 0)
      children.push(
        <span key={`sep${i}`} className="sbi-sep">
          ·
        </span>
      )
    children.push(p)
  })

  // 底部路径：跟随当前激活分组的 cwd（rev 驱动，同原 toolbar.render 的时机）
  const cwd = getSessionInfoCtx()?.cwd ?? ''

  return (
    <div className="statusbar">
      <span id="sbSession" className="sb-session" hidden={children.length === 0}>
        {children}
      </span>
      {/* 双击底部路径 → 用系统资源管理器打开该目录。双击同时会选中一个词，属预期，
          不阻止；用户仍可拖选复制路径。 */}
      <span
        id="sbCwd"
        title={cwd ? `${cwd}\n${t('双击用资源管理器打开')}` : ''}
        onDoubleClick={() => {
          const p = cwd.trim()
          if (!p) return
          void window.term.openPath(p).then((r) => {
            if (!r.ok) toast(t('打开失败：{0}', r.error ?? t('未知错误')))
          })
        }}
      >
        {cwd}
      </span>
    </div>
  )
}
