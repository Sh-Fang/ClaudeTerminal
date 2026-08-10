// 悬浮窗 UI：窗口是"菜单包络"大小的透明窗，鼠标穿透由主进程轮询光标管理，这里只画胶囊和右键菜单。
// FloaterCounts 手抄一份，避免跨 tsconfig import preload。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { t } from '../i18n'

interface FloaterCounts {
  done: number
  attention: number
  busy: number
  total: number
}

interface CtxItem {
  label?: string
  icon?: string
  danger?: boolean
  sep?: boolean
  act?: () => void
}

const MENU_PAD = 8

const ICON_OPEN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>'
const ICON_EYE_OFF =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.79 19.79 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.78 19.78 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'

export function FloaterApp() {
  const [counts, setCounts] = useState<FloaterCounts>({ done: 0, attention: 0, busy: 0, total: 0 })
  // menu 非空即菜单打开；menuPos 为空表示"已渲染但还没量完尺寸"（离屏定位阶段）
  const [menu, setMenu] = useState<{ items: CtxItem[]; x: number; y: number } | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  // 全局监听器里要读"当前是否开着"，用 ref 镜像避免反复重挂监听
  const menuOpenRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const ctxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const off = window.term?.onFloaterCounts?.((c) => setCounts(c))
    return () => {
      off?.()
    }
  }, [])

  const openCtx = useCallback((items: CtxItem[], x: number, y: number): void => {
    menuOpenRef.current = true
    setMenuPos(null) // 先离屏渲染量尺寸，useLayoutEffect 里再定位
    setMenu({ items, x, y })
    // focusable=true 既让 blur 能捕捉"点到窗外"，也是主进程"菜单开着别切穿透"的信号
    window.term?.floaterSetFocusable?.(true)
  }, [])

  const closeCtx = useCallback((): void => {
    if (!menuOpenRef.current) return
    menuOpenRef.current = false
    setMenu(null)
    setMenuPos(null)
    window.term?.floaterSetFocusable?.(false)
  }, [])

  // 菜单渲染后量实际尺寸再决定展开方向
  useLayoutEffect(() => {
    if (!menu) return
    const el = ctxRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    // 窗口可能伸出屏幕外，翻转判断必须用屏幕剩余空间而非窗口内坐标
    const sx = window.screenX + menu.x
    const sy = window.screenY + menu.y
    const scr = window.screen as Screen & { availLeft?: number; availTop?: number }
    const availL = scr.availLeft ?? 0
    const availT = scr.availTop ?? 0
    let px = sx + w + MENU_PAD <= availL + scr.availWidth ? menu.x : menu.x - w
    let py = sy + h + MENU_PAD <= availT + scr.availHeight ? menu.y : menu.y - h
    px = Math.min(Math.max(0, px), window.innerWidth - w - 2)
    py = Math.min(Math.max(0, py), window.innerHeight - h - 2)
    setMenuPos({ x: px, y: py })
  }, [menu])

  useEffect(() => {
    // 关闭路径：左键点到菜单外 / window blur / Esc；右键交给 contextmenu 的 toggle 语义
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return
      if (!(e.target as HTMLElement).closest('#ctx')) closeCtx()
    }
    const onBlur = (): void => closeCtx()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeCtx()
    }
    // 穿透态下右键被 OS 接走，能到这里的 contextmenu 必然发生在胶囊/菜单上
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      // 已开着 → 再次右键 toggle 关闭
      if (menuOpenRef.current) {
        closeCtx()
        return
      }
      openCtx(
        [
          { label: t('打开主窗口'), icon: ICON_OPEN, act: () => window.term?.floaterFocusMain?.() },
          { sep: true },
          { label: t('隐藏悬浮窗'), icon: ICON_EYE_OFF, danger: true, act: () => window.term?.floaterHide?.() }
        ],
        e.clientX,
        e.clientY
      )
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [closeCtx, openCtx])

  // 手动拖动：不用 -webkit-app-region:drag（OS 拖动会把窗口顶边钳在屏幕内，胶囊贴不到屏顶），
  // 改为 pointer capture + 主进程 setPosition 程序化移窗。
  const dragRef = useRef({
    dragging: false,
    dragMoved: false,
    start: { mx: 0, my: 0, wx: 0, wy: 0 },
    movePending: false,
    target: { x: 0, y: 0 }
  })

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const d = dragRef.current
    d.dragging = true
    d.dragMoved = false
    d.start = { mx: e.screenX, my: e.screenY, wx: window.screenX, wy: window.screenY }
    try {
      cardRef.current?.setPointerCapture(e.pointerId)
    } catch {}
    // 拖动中窗口位置滞后于光标，通知主进程挂起穿透轮询
    window.term?.floaterDragState?.(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d.dragging) return
    const dx = e.screenX - d.start.mx
    const dy = e.screenY - d.start.my
    if (!d.dragMoved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return
    d.dragMoved = true
    d.target = { x: d.start.wx + dx, y: d.start.wy + dy }
    if (d.movePending) return
    d.movePending = true
    requestAnimationFrame(() => {
      d.movePending = false
      window.term?.floaterMoveTo?.(d.target.x, d.target.y)
    })
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d.dragging) return
    d.dragging = false
    try {
      cardRef.current?.releasePointerCapture(e.pointerId)
    } catch {}
    window.term?.floaterDragState?.(false)
  }

  return (
    <>
      {/* menu-open 让卡片不抢拖动事件，确保 mousedown 能派发到 renderer 关菜单 */}
      <div
        className={'card' + (menu ? ' menu-open' : '')}
        ref={cardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div id="items">
          {/* 黄(待决策) → 蓝(运行中) → 绿(待查看)，三列常驻不隐藏 0 */}
          <span className="item">
            <span className="dot attention" />
            <span className="num">{counts.attention}</span>
          </span>
          <span className="sep" />
          <span className="item">
            <span className="dot busy" />
            <span className="num">{counts.busy}</span>
          </span>
          <span className="sep" />
          <span className="item">
            <span className="dot done" />
            <span className="num">{counts.done}</span>
          </span>
        </div>
      </div>
      {/* 未定位前先画在 -9999 离屏处，layout effect 量完尺寸再落位 */}
      <div
        id="ctx"
        ref={ctxRef}
        className={'ctx' + (menu ? ' open' : '')}
        style={menu ? (menuPos ? { left: menuPos.x, top: menuPos.y } : { left: -9999, top: 0 }) : undefined}
      >
        {menu?.items.map((it, i) =>
          it.sep ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <div
              key={i}
              className={'ctx-item' + (it.danger ? ' danger' : '')}
              onClick={() => {
                closeCtx()
                it.act?.()
              }}
            >
              <span className="ic" dangerouslySetInnerHTML={{ __html: it.icon ?? '' }} />
              <span>{it.label ?? ''}</span>
            </div>
          )
        )}
      </div>
    </>
  )
}
