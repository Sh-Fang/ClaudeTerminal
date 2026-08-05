import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../state/store'
import { getSettings, setHostsEl, refitActive } from '../controller'
import { backgroundFor } from '../themes'
import { t } from '../i18n'

// 终端宿主区：#hosts + 空态占位。
// 注意：xterm 的 .term-host 容器由 terminal-tab.ts 命令式 append 到 #hosts 下，
// React 只声明/管理 #hosts-empty 这一个子节点，不做任何会重排 children 的操作
// （空态显隐由 CSS 的 #hosts:has(.term-host.active) 控制，无需 JS）。
export function TerminalHosts() {
  const rev = useAppStore((s) => s.rev)
  void rev

  const hostRef = useRef<HTMLDivElement | null>(null)
  // ref 回调：元素一到手就交给 controller（initApp 靠 setHostsEl resolve hostsReady）。
  // useCallback 稳住回调引用，避免每次 rev 重渲染都被 React 走一遍 null→el。
  const refCb = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el
    setHostsEl(el)
  }, [])

  // 拖窗口时 ResizeObserver 会高频回调，逐帧 refit → 逐帧把 cols push 给 PTY → cc 每帧收
  // SIGWINCH 重画，既抖又费；每次 cols 变化还会惊动一次 ConPTY reflow（xterm 侧的 disableReflow
  // 够不着它）。这里 trailing 去抖：拖动过程只等 CSS 吃满，停手 ~120ms 后一次性 refit 到位，把中间
  // 一连串 resize 合并成一次，顺带把 ConPTY reflow 的触发次数压到最少。
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let roTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (roTimer != null) window.clearTimeout(roTimer)
      roTimer = window.setTimeout(() => {
        roTimer = null
        refitActive()
      }, 120)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (roTimer != null) window.clearTimeout(roTimer)
    }
  }, [])

  return (
    <div
      id="hosts"
      ref={refCb}
      // 终端区背板跟随终端主题背景：term-host 左侧 4px 缓冲带 / 空态露出的就是它
      style={{ background: backgroundFor(getSettings().terminal.theme) }}
    >
      <div id="hosts-empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
          <polyline points="6.5 9 10 12 6.5 15" />
          <line x1="12.5" y1="15" x2="17.5" y2="15" />
        </svg>
        <div className="hint">{t('没有打开的会话')}</div>
        <div className="sub">{t('左侧点「新建分组」开始，或从「已保存的分组」恢复')}</div>
      </div>
    </div>
  )
}
