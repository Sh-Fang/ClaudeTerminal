import { useEffect } from 'react'
import { t } from '../i18n'

// 标题栏：brand + 自绘窗口控制三键；macOS 用系统红绿灯，CSS 据 body.platform-mac 隐藏自绘按钮。
export function TitleBar() {
  // 最大化时切「还原」图标：body.win-maximized 驱动 CSS，订阅主进程状态 + 拉一次初始态
  useEffect(() => {
    if (window.term.platform === 'darwin') return
    const applyMax = (maximized: boolean): void => {
      document.body.classList.toggle('win-maximized', maximized)
    }
    const off = window.term.onWindowState((s) => applyMax(s.maximized))
    void window.term.winIsMaximized().then(applyMax)
    return () => off()
  }, [])

  return (
    <div
      className="titlebar"
      // 双击 titlebar 切最大化（macOS 同款行为）；点在窗口控制键上的双击除外
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.win-ctrls')) return
        window.term.winToggleMaximize()
      }}
    >
      <div className="brand">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="2" width="22" height="20" rx="5.5" fill="currentColor" />
            <polyline
              points="6.5 9 10 12 6.5 15"
              fill="none"
              stroke="white"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line x1="12.5" y1="15" x2="17.5" y2="15" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
        Claude Terminal
      </div>
      <div className="titlebar-spacer"></div>
      <div className="win-ctrls" aria-label={t('窗口控制')}>
        <button
          id="win-min"
          className="win-btn c-min"
          title={t('最小化')}
          aria-label={t('最小化')}
          onClick={() => window.term.winMinimize()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M1.5 5 H8.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
        <button
          id="win-max"
          className="win-btn c-max"
          title={t('最大化')}
          aria-label={t('最大化')}
          onClick={() => window.term.winToggleMaximize()}
        >
          <svg className="ico-maximize" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
          <svg className="ico-restore" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M3 3 V1.5 H8.5 V7 H7" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="1.5" y="3" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
        <button
          id="win-close"
          className="win-btn c-close"
          title={t('关闭')}
          aria-label={t('关闭')}
          onClick={() => window.term.winClose()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  )
}
