import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '../state/store'
import { busOn } from '../state/bus'
import { showCtxMenu, toast } from '../state/overlays'
import {
  getLearnedModels,
  getSessionInfoCtx,
  getSettings,
  learnModelFromSession,
  switchActiveModel,
  switchActiveEffort
} from '../controller'
import { t } from '../i18n'
import { isRowActive, modelGroupsWithLearned } from '../../../shared/claude-models'

// 思考强度候选；cc 仅在模型支持 effort 时上报，芯片会自动隐藏
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

const TICK_MS = 3000 // 上下文用量每 3s 刷新一次
const BRANCH_EVERY = 7 // 分支约每 21s 重查一次（切换时立即查）

function ctxLevel(p: number): string {
  if (p >= 90) return 'lv-danger'
  if (p >= 70) return 'lv-warn'
  return 'lv-ok'
}

function clip(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// effort 档位展示用首字母大写；注入命令仍用原始小写
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

// 一次 poll 的渲染快照
interface Snap {
  hasActive: boolean // 有活跃会话 → 展示 ctx / 模型骨架
  usage: SessionUsage | null
  // 上一次成功拿到的模型身份，cc 还没上报 usage 时兜底
  stickyModel: { id?: string; label?: string } | null
  branch: string | null
}

export function SessionInfoBar() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const [snap, setSnap] = useState<Snap>({ hasActive: false, usage: null, stickyModel: null, branch: null })

  // 轮询 + nudge 订阅；poll 的全部可变状态收在 effect 闭包里
  useEffect(() => {
    let lastKey = ''
    let branch: string | null = null
    let usage: SessionUsage | null = null
    let stickyModel: { id?: string; label?: string } | null = null
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
      const key = `${a.tabId}::${a.ptyId ?? ''}::${a.sessionId ?? ''}::${a.cwd}`
      const changed = key !== lastKey
      if (changed) {
        lastKey = key
        tick = 0
        branch = null
        usage = null
        stickyModel = null
      }
      try {
        if (changed || tick % BRANCH_EVERY === 0) {
          branch = a.cwd ? await window.term.gitBranch(a.cwd) : null
        }
        if (a.sessionId) {
          const u = await window.term.claudeSessionUsage(a.sessionId)
          usage = u.exists ? u : null
          if (u.exists && (u.model || u.modelLabel)) {
            stickyModel = { id: u.model, label: u.modelLabel }
            // cc 正跑着这个模型 = 用户切成功了：内置候选里没有就补进列表（如 opus-5）
            if (u.model) learnModelFromSession(u.model, u.modelLabel)
          }
        } else {
          usage = null
        }
      } catch {
        // 单次失败忽略，下个 tick 再来
      }
      tick++
      // poll 期间可能又切了标签；仍是同一目标才绘制，避免串台
      const now = getSessionInfoCtx()
      if (now && `${now.tabId}::${now.ptyId ?? ''}::${now.sessionId ?? ''}::${now.cwd}` === key) {
        setSnap({ hasActive: !!now.sessionId, usage, stickyModel, branch })
      }
    }

    const poll = async (): Promise<void> => {
      // 并发护栏：慢 IPC 可能跨 tick，重叠执行会互相覆盖状态
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
    // 切换标签/会话时 controller busEmit 催一次，立即刷新
    const offNudge = busOn('sessionInfo:nudge', kick)
    return () => {
      window.clearInterval(timer)
      offNudge()
    }
  }, [])

  const openModelMenu = (anchor: HTMLElement): void => {
    const activeId = snap.usage?.model ?? snap.stickyModel?.id
    const activeLabel = snap.usage?.modelLabel ?? snap.stickyModel?.label
    const r = anchor.getBoundingClientRect()
    // showCtxMenu 会把菜单夹在视口内，芯片贴底时自动向上弹；各家族间插分隔线。
    // 候选 = 内置列表 + 运行时学到的模型（用户手动切成功过的新模型）
    showCtxMenu(
      modelGroupsWithLearned(getLearnedModels()).flatMap((g, gi) => [
        ...(gi > 0 ? [{ sep: true }] : []),
        ...g.rows.map((row) => ({
          label: row.label,
          icon: isRowActive(row, activeId, activeLabel) ? '✓' : '',
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
    // 菜单从上到下高→低，渲染时倒序
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

  // 额度样式为 'ring' 时 ctx 也画成迷你圆环
  const usageStyle = getSettings().usageStyle || 'bar'
  const u = snap.usage
  const parts: ReactNode[] = []
  // 顺序：ctx · 模型 · git 分支。有 active session 就展示骨架：ctx 默认 0%，
  // 模型用 stickyModel 兜底，都没有退到占位 "Claude"。
  if (snap.hasActive) {
    const hasCtx = !!(u && typeof u.ctxPercent === 'number')
    const p = hasCtx ? (u!.ctxPercent as number) : 0
    const lv = ctxLevel(p)
    const tip =
      hasCtx && u!.ctxTokens != null
        ? t('上下文 {0} / {1} tokens', u!.ctxTokens!.toLocaleString(), (u!.ctxWindow ?? 0).toLocaleString()) +
          (u!.ctxApprox ? t('（估算值）') : '')
        : t('新会话，暂无上下文用量')
    if (usageStyle === 'ring') {
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
    const model = u?.modelLabel ?? snap.stickyModel?.label ?? snap.stickyModel?.id ?? 'Claude'
    parts.push(
      <span
        key="model"
        className="sbi-model"
        title={t('点击切换模型')}
        onClick={(e) => {
          // stopPropagation 挡掉"点空白关菜单"的 document handler，否则刚开就被关
          e.stopPropagation()
          openModelMenu(e.currentTarget)
        }}
      >
        {model}
      </span>
    )
    // effort 芯片：仅在 cc 上报了 effort 时展示
    const eff = u?.effort
    if (eff) {
      parts.push(
        <span
          key="effort"
          className="sbi-effort"
          title={t('点击切换思考强度')}
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

  // 底部路径：跟随当前激活分组的 cwd（rev 驱动）
  const cwd = getSessionInfoCtx()?.cwd ?? ''

  return (
    <div className="statusbar">
      <span id="sbSession" className="sb-session" hidden={children.length === 0}>
        {children}
      </span>
      {/* 双击底部路径用资源管理器打开该目录 */}
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
