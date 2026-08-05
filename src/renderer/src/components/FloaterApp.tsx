// 悬浮窗 UI（React 版）：逐条对照原 floater-bootstrap.ts 移植。
// 窗口是"菜单包络"大小的透明窗，胶囊固定在中央偏移处（见 floater.html .card）。
// 鼠标穿透由主进程轮询光标位置管理（胶囊是穿透管理对象，页面收不到它上面的
// 悬停事件，渲染层做不了悬停检测）；这里只负责画胶囊和右键菜单。
// 右键菜单直接在窗口内展开，零窗口 resize。
// 这里手抄一份 FloaterCounts 结构，避免跨 tsconfig 直接 import preload。
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

  // ─── 计数订阅 ─────────────────────────────────────────────────────
  useEffect(() => {
    const off = window.term?.onFloaterCounts?.((c) => setCounts(c))
    return () => {
      off?.()
    }
  }, [])

  // ─── 右键菜单开关（命令式函数，保持与原实现相同的守卫与 IPC 时序） ───
  const openCtx = useCallback((items: CtxItem[], x: number, y: number): void => {
    menuOpenRef.current = true
    setMenuPos(null) // 先离屏渲染量尺寸，useLayoutEffect 里再定位
    setMenu({ items, x, y })
    // 临时变成可聚焦并 focus：blur 监听用来捕捉"点了悬浮窗外面"；
    // 同时 focusable=true 也是主进程侧"菜单开着，别切穿透"的信号
    window.term?.floaterSetFocusable?.(true)
  }, [])

  const closeCtx = useCallback((): void => {
    if (!menuOpenRef.current) return
    menuOpenRef.current = false
    setMenu(null)
    setMenuPos(null)
    window.term?.floaterSetFocusable?.(false)
  }, [])

  // 菜单渲染出来后量实际尺寸，再决定往哪边展开（对照原 openCtx 的翻转/夹回逻辑）
  useLayoutEffect(() => {
    if (!menu) return
    const el = ctxRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    // 窗口可能有一截伸出屏幕外（胶囊贴屏幕边缘时），翻转判断要用"屏幕剩余空间"，
    // 不能只看窗口内坐标 —— 否则菜单会展开到屏幕外的窗口区域里。
    const sx = window.screenX + menu.x
    const sy = window.screenY + menu.y
    const scr = window.screen as Screen & { availLeft?: number; availTop?: number }
    const availL = scr.availLeft ?? 0
    const availT = scr.availTop ?? 0
    let px = sx + w + MENU_PAD <= availL + scr.availWidth ? menu.x : menu.x - w
    let py = sy + h + MENU_PAD <= availT + scr.availHeight ? menu.y : menu.y - h
    // 兜底夹回窗口内
    px = Math.min(Math.max(0, px), window.innerWidth - w - 2)
    py = Math.min(Math.max(0, py), window.innerHeight - h - 2)
    setMenuPos({ x: px, y: py })
  }, [menu])

  // ─── window/document 级监听（打开 + 三条关闭路径） ─────────────────
  useEffect(() => {
    // 关闭路径：
    // 1. 左键点到菜单以外（胶囊上）—— 走 mousedown 监听
    // 2. 点到悬浮窗外面（其他 app / 桌面）—— 走 window blur
    // 3. Esc 键
    // 右键不在 mousedown 里关（交给 contextmenu 的 toggle 语义处理）。
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return
      if (!(e.target as HTMLElement).closest('#ctx')) closeCtx()
    }
    const onBlur = (): void => closeCtx()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeCtx()
    }
    // 穿透态下右键会被 OS 接走，能触发到这里的 contextmenu 必然发生在胶囊/菜单上
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      // 已经开着 → 再次右键当作关闭（toggle），不要在新位置重开导致闪烁
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

  // ─── 手动拖动 ─────────────────────────────────────────────────────
  // 不用 -webkit-app-region:drag：OS 交互拖动会把"窗口顶边"钳在屏幕内，而窗口
  // 顶部有 130px 菜单留白 → 胶囊永远贴不到屏顶。改为 pointer capture 手动拖，
  // 主进程 setPosition 程序化移窗（不受钳制，窗口可为负坐标）。
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
    // 通知主进程挂起穿透轮询：拖动中窗口位置滞后于光标，按位置判断会误切穿透
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
    // rAF 节流：每帧最多推一次坐标
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
      {/* 菜单打开期间给卡片加 menu-open：让卡片不抢拖动事件，确保 mousedown 能派发到 renderer 关菜单 */}
      <div
        className={'card' + (menu ? ' menu-open' : '')}
        ref={cardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div id="items">
          {/* 顺序：黄(待决策) → 蓝(运行中) → 绿(待查看)。三块常驻不隐藏 0，
              中间用竖条分隔。固定三列让数字位置稳定，扫一眼就能定位。 */}
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
      {/* 未定位前先画在 -9999 离屏处，layout effect 量完尺寸再落位（与原实现一致） */}
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
