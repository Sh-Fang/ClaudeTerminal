import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../state/store'
import { getSettings, setHostsEl, refitActive } from '../controller'
import { backgroundFor } from '../themes'
import { t } from '../i18n'

// 终端宿主区：xterm 的 .term-host 由 terminal-tab.ts 命令式 append 到 #hosts 下，
// React 只管理 #hosts-empty 这一个子节点，不做任何会重排 children 的操作。
export function TerminalHosts() {
  const rev = useAppStore((s) => s.rev)
  void rev

  const hostRef = useRef<HTMLDivElement | null>(null)
  // 元素一到手就交给 controller；useCallback 稳住引用，避免每次重渲染走一遍 null→el
  const refCb = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el
    setHostsEl(el)
  }, [])

  // resize 用 trailing 去抖（~120ms）：逐帧 refit 会逐帧触发 SIGWINCH 与 ConPTY reflow，既抖又费
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
      // 终端区背板跟随终端主题背景
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
