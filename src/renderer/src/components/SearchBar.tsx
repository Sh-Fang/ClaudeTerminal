import { useEffect, useRef, useState } from 'react'
import { useOverlays, closeSearchOverlay } from '../state/overlays'
import { activeContext } from '../controller'
import { t } from '../i18n'
import type { TerminalTab } from '../terminal-tab'

const SEARCH_DECOR = {
  // 普通匹配：暗黄背景 + 亮黄描边
  matchBackground: '#3a3a00',
  matchBorder: '#e5e510',
  matchOverviewRuler: '#e5e510',
  // 当前匹配：亮橙 + 白描边，与普通匹配拉开对比度
  activeMatchBackground: '#ff8800',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ff8800'
}

// 终端内搜索浮层：开合状态在 overlays store，Ctrl+F 等入口由 controller 调 openSearchOverlay()
export function SearchBar() {
  const open = useOverlays((s) => s.searchOpen)
  const [count, setCount] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 计数回调绑定的目标 tab：切 tab 后旧回调据此自行失效
  const boundRef = useRef<TerminalTab | null>(null)
  const lastQueryRef = useRef('')
  // SearchAddon 不提供解绑句柄，用 WeakSet 保证每 tab 只订阅一次
  const subsRef = useRef(new WeakSet<TerminalTab>())

  const rebindSearch = (tab: TerminalTab): void => {
    boundRef.current = tab
    if (subsRef.current.has(tab)) return
    subsRef.current.add(tab)
    tab.search.onDidChangeResults?.((e) => {
      if (boundRef.current !== tab) return
      if (!e || e.resultCount === 0) {
        setCount(lastQueryRef.current ? '0' : '')
        return
      }
      setCount(`${e.resultIndex + 1}/${e.resultCount}`)
    })
  }

  const runSearch = (direction: 'next' | 'prev'): void => {
    const ctx = activeContext()
    if (!ctx) return
    rebindSearch(ctx.tab)
    const q = inputRef.current?.value ?? ''
    lastQueryRef.current = q
    if (!q) {
      ctx.tab.term.clearSelection()
      setCount('')
      return
    }
    const opts = { decorations: SEARCH_DECOR }
    if (direction === 'next') ctx.tab.search.findNext(q, opts)
    else ctx.tab.search.findPrevious(q, opts)
  }

  // 显式关闭：清高亮 + 清选区 + 焦点还给终端
  const doClose = (): void => {
    closeSearchOverlay()
    const ctx = activeContext()
    ctx?.tab.search.clearDecorations()
    ctx?.tab.term.clearSelection()
    ctx?.tab.term.focus()
  }

  // 打开时：绑定当前 tab 的结果回调，聚焦并全选输入框；无活动标签直接回退关闭
  useEffect(() => {
    if (!open) return
    const ctx = activeContext()
    if (!ctx) {
      closeSearchOverlay()
      return
    }
    rebindSearch(ctx.tab)
    inputRef.current?.focus()
    inputRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 全局 Esc 兜底：焦点不在输入框时也能收起浮层；这条路径只收起、不清高亮
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSearchOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div id="search" className={open ? 'open' : ''} role="search" aria-label={t('终端内搜索')}>
      <input
        id="search-input"
        ref={inputRef}
        type="text"
        placeholder={t('搜索（Enter 下一个，Shift+Enter 上一个）')}
        autoComplete="off"
        spellCheck={false}
        onInput={() => runSearch('next')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            runSearch(e.shiftKey ? 'prev' : 'next')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            doClose()
          }
        }}
      />
      <span id="search-count" aria-live="polite">{count}</span>
      {/* mousedown preventDefault：点按钮不夺走输入框焦点，Enter 连跳不中断 */}
      <button
        id="search-prev"
        title={t('上一个（Shift+Enter）')}
        aria-label={t('上一个（Shift+Enter）')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runSearch('prev')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        id="search-next"
        title={t('下一个（Enter）')}
        aria-label={t('下一个（Enter）')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runSearch('next')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button id="search-close" title={t('关闭 (Esc)')} aria-label={t('关闭搜索')} onClick={() => doClose()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
