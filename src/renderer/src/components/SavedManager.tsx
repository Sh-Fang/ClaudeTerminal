// 「分组/工作区管理」弹窗：重命名 / 删除 / 恢复 / 搜索 / A-Z 跳转。
// 开合订阅 overlays store，数据与动作全部走 controller。

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { icon } from '../svg-icons'
import { t } from '../i18n'
import { useAppStore } from '../state/store'
import { useOverlays, closeSavedManager, confirmDialog, showCtxMenu, type CtxItem } from '../state/overlays'
import { escapeHtml, formatTs, shortPath, fuzzySearch, highlightRanges, nameInitial, srcLabel, type Range } from '../lib/format'
import { getManageGroupViews, getManageWorkspaceViews, savedManagerApi } from '../controller'
import type { ManageGroupView, ManageTabView, ManageWorkspaceView } from '../app-types'

type ManageTabName = 'groups' | 'workspaces'

// 会话标题命中（仅搜重命名过的会话）：在对应标签行下方显示「↳ 会话」提示，点击直接恢复到该会话
interface SessHit {
  tabId: string
  sessionId: string
  title: string
  hl?: Range[]
}

interface GroupHit {
  g: ManageGroupView
  hl: Range[][]
  sess: Map<string, SessHit[]>
}

// 命中规则：分组名/路径/标签名/重命名过的会话标题任一命中即整组保留，按最高匹配分倒序；
// 路径参与匹配但不高亮（短显示串下标对不上）。
function matchGroups(all: ManageGroupView[], q: string): GroupHit[] {
  if (!q) return all.map((g) => ({ g, hl: [] as Range[][], sess: new Map<string, SessHit[]>() }))
  const scored: Array<GroupHit & { score: number }> = []
  for (const g of all) {
    const fields = [g.name, g.cwd, ...g.tabs.map((tb) => tb.name)]
    const weights = [3, 1, ...g.tabs.map(() => 2)]
    const r = fuzzySearch(q, fields, weights)
    const sess = new Map<string, SessHit[]>()
    let bestSess = 0
    for (const tb of g.tabs) {
      for (const s of tb.sessions) {
        if (!s.hasUserTitle) continue
        const sr = fuzzySearch(q, [s.title])
        if (!sr) continue
        const arr = sess.get(tb.id) ?? []
        arr.push({ tabId: tb.id, sessionId: s.sessionId, title: s.title, hl: sr.highlights[0] })
        sess.set(tb.id, arr)
        if (sr.score > bestSess) bestSess = sr.score
      }
    }
    if (!r && sess.size === 0) continue
    scored.push({ g, hl: r?.highlights ?? [], sess, score: Math.max(r?.score ?? 0, bestSess) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map(({ g, hl, sess }) => ({ g, hl, sess }))
}

// 会话选择浮层（管理页专用）：选一条 = 恢复该标签页并以该会话为活跃会话
interface SessPickEntry {
  sessionId: string
  title: string
  source: string
  ts?: string
  isDefault: boolean // 该标签默认活跃会话
}

interface SessPickState {
  anchor: HTMLElement
  savedId: string
  tabId: string
  entries: SessPickEntry[]
}

function sessMetaHtml(e: SessPickEntry): string {
  return `${escapeHtml(formatTs(e.ts))} · <span class="src">${escapeHtml(srcLabel(e.source))}</span> · ${escapeHtml(e.sessionId.slice(0, 8))}${e.isDefault ? ` · <span class="cur">${t('默认')}</span>` : ''}`
}

function SessPickFloat(props: {
  anchor: HTMLElement
  entries: SessPickEntry[]
  title: string
  onPick: (sessionId: string) => void
  onClose: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const { anchor, onClose } = props

  // 定位：锚点下方左对齐；放不下时选空间更大的一侧并把高度收进该侧可用高度
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const r = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const MARGIN = 8
    const GAP = 4
    const SAFE_TOP = 40 // 标题栏 32px + 余量：浮层不越过此线
    const spaceBelow = vh - r.bottom - GAP - MARGIN
    const spaceAbove = r.top - GAP - MARGIN - SAFE_TOP
    const placeBelow = spaceBelow >= spaceAbove
    const avail = Math.max(Math.floor(placeBelow ? spaceBelow : spaceAbove), 120)
    host.style.maxHeight = `${avail}px`
    const pw = host.offsetWidth
    const ph = host.offsetHeight
    let left = r.left
    if (left + pw > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - pw)
    let top = placeBelow ? r.bottom + GAP : r.top - GAP - ph
    top = Math.max(SAFE_TOP, top)
    host.style.left = `${Math.round(left)}px`
    host.style.top = `${Math.round(top)}px`
  }, [anchor, props.entries])

  useEffect(() => {
    const host = hostRef.current
    const onDocDown = (e: MouseEvent): void => {
      if (host?.contains(e.target as Node) || anchor.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onGone = (): void => onClose()
    // 仅浮层外部滚动才关闭（外部滚动会让锚点移位）
    const onScroll = (e: Event): void => {
      if (host?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onGone, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onGone, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose])

  return (
    <div className="sesspick" ref={hostRef}>
      <div className="sesspick-head">{props.title}</div>
      {props.entries.map((en) => (
        <div
          key={en.sessionId}
          className={'sesspick-item sess-item' + (en.isDefault ? ' current' : '')}
          data-sp-sid={en.sessionId}
          onClick={() => {
            onClose()
            props.onPick(en.sessionId)
          }}
        >
          <span className="sdot"></span>
          <div className="sess-body">
            <div className="sess-title">{en.title}</div>
            <div className="sess-meta" dangerouslySetInnerHTML={{ __html: sessMetaHtml(en) }} />
          </div>
        </div>
      ))}
    </div>
  )
}

type EditKind = 'group' | 'tab' | 'workspace'
interface Editing {
  kind: EditKind
  payload: string // group/workspace 为 id；tab 为 `${savedId}::${tabId}`
  old: string
}

interface EditableBind {
  contentEditable?: true
  suppressContentEditableWarning?: true
  'data-editing'?: string
  ref?: (el: HTMLElement | null) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void
}

export function SavedManager() {
  const isOpen = useOverlays((s) => s.savedManagerOpen)
  const initialView = useOverlays((s) => s.savedManagerView)
  const rev = useAppStore((s) => s.rev)
  void rev // rev 变化即重渲染，渲染时直接调 controller getter 拿最新数据

  const [activeTab, setActiveTab] = useState<ManageTabName>('groups')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sessPick, setSessPick] = useState<SessPickState | null>(null)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const editElRef = useRef<HTMLElement | null>(null)
  const editingRef = useRef<Editing | null>(null) // commit 幂等守卫（blur/Enter 可能双触发）
  const downOnScrimRef = useRef(false)

  const wasOpenRef = useRef(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      if (initialView) setActiveTab(initialView)
      setSearchQuery('')
      setEditing(null)
      editingRef.current = null
      searchRef.current?.focus()
    }
    wasOpenRef.current = isOpen
  }, [isOpen, initialView])

  // 列表重建 / 切页 / 搜索 / 关闭 → 关掉残留的会话浮层，避免锚点失效
  useEffect(() => {
    setSessPick(null)
  }, [rev, activeTab, searchQuery, expanded, isOpen])

  // Esc：先清空搜索，再次 Esc 才关弹窗；Tab：在两个页签间切换（行内改名中不抢）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        if ((e.target as HTMLElement).closest?.('[contenteditable="true"]')) return
        e.preventDefault()
        setActiveTab((prev) => (prev === 'groups' ? 'workspaces' : 'groups'))
        return
      }
      if (e.key !== 'Escape') return
      if (searchQuery) {
        setSearchQuery('')
        return
      }
      closeSavedManager()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, searchQuery])

  // 改名开始光标 collapse 到末尾（不全选）
  useLayoutEffect(() => {
    if (!editing) return
    const el = editElRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    el.focus()
  }, [editing])

  const beginRename = (kind: EditKind, payload: string, old: string): void => {
    const ed: Editing = { kind, payload, old }
    editingRef.current = ed
    setEditing(ed)
  }

  const commitRename = (el: HTMLElement, cancel: boolean): void => {
    const ed = editingRef.current
    if (!ed) return
    editingRef.current = null
    setEditing(null)
    const v = (el.textContent || '').trim()
    if (cancel || !v) {
      // React 不感知 contentEditable 里的手输内容，取消时手动还原
      el.textContent = ed.old
      return
    }
    if (v === ed.old) return
    if (ed.kind === 'tab') {
      const [savedId, tabId] = ed.payload.split('::')
      if (savedId && tabId) savedManagerApi.onRenameTab(savedId, tabId, v)
    } else if (ed.kind === 'workspace') {
      savedManagerApi.onRenameWorkspace(ed.payload, v)
    } else {
      savedManagerApi.onRename(ed.payload, v)
    }
  }

  const onEditKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(e.currentTarget, false)
    } else if (e.key === 'Escape') {
      // stopPropagation：Esc 只取消改名，不关整个弹窗
      e.preventDefault()
      e.stopPropagation()
      commitRename(e.currentTarget, true)
    }
  }

  const editableProps = (kind: EditKind, payload: string): EditableBind => {
    const on = editing?.kind === kind && editing.payload === payload
    if (!on) return {}
    return {
      contentEditable: true,
      suppressContentEditableWarning: true,
      'data-editing': '1',
      ref: (el) => {
        editElRef.current = el
      },
      onBlur: (e) => commitRename(e.currentTarget, false),
      onKeyDown: onEditKeyDown
    }
  }

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onHeadClick = (e: ReactMouseEvent, id: string): void => {
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
    toggleExpand(id)
  }

  const switchTab = (name: ManageTabName): void => {
    if (activeTab === name) return
    setActiveTab(name)
    setSearchQuery('')
  }

  const confirmDeleteTab = (savedId: string, tabId: string, tabName: string): void => {
    confirmDialog({
      title: t('从保存里移除「{0}」？', escapeHtml(tabName)),
      message: t('只把该标签从保存记录里删除，已打开的实例不受影响。'),
      okLabel: t('删除'),
      onOk: () => savedManagerApi.onDeleteTab(savedId, tabId)
    })
  }

  // 右键菜单：重命名 / 恢复 / 删除（删除均有二次确认）；正在改名时右键放行
  const onGroupCtx = (e: ReactMouseEvent, g: ManageGroupView): void => {
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
    e.preventDefault()
    e.stopPropagation()
    const items: CtxItem[] = [
      { label: t('重命名'), icon: icon('edit'), act: () => beginRename('group', g.id, g.name) },
      { label: t('恢复所有标签页'), icon: icon('rotate-ccw'), act: () => savedManagerApi.onRestoreAll(g.id) },
      { label: t('新增标签页'), icon: icon('plus'), act: () => savedManagerApi.onAddTabToSaved(g.id) },
      { sep: true },
      { label: t('删除分组'), icon: icon('trash'), danger: true, act: () => savedManagerApi.onDelete(g.id) }
    ]
    showCtxMenu(items, e.clientX, e.clientY)
  }

  const onTabCtx = (e: ReactMouseEvent, g: ManageGroupView, tab: ManageTabView): void => {
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
    e.preventDefault()
    e.stopPropagation()
    const tabName = tab.name.trim() || t('该标签')
    const items: CtxItem[] = [
      { label: t('重命名'), icon: icon('edit'), act: () => beginRename('tab', `${g.id}::${tab.id}`, tab.name) },
      { label: t('恢复该标签页'), icon: icon('rotate-ccw'), act: () => savedManagerApi.onRestoreOneTab(g.id, tab.id) },
      { sep: true },
      { label: t('删除标签页'), icon: icon('trash'), danger: true, act: () => confirmDeleteTab(g.id, tab.id, tabName) }
    ]
    showCtxMenu(items, e.clientX, e.clientY)
  }

  // 工作区展开后的分组行：只有恢复和删除（不支持重命名）
  const onWsGrpCtx = (e: ReactMouseEvent, wsId: string, groupId: string, grpNameRaw: string): void => {
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
    e.preventDefault()
    e.stopPropagation()
    const grpName = grpNameRaw.trim() || t('该分组')
    const items: CtxItem[] = [
      { label: t('恢复该分组'), icon: icon('rotate-ccw'), act: () => savedManagerApi.onRestoreWorkspaceGroup(wsId, groupId) },
      { sep: true },
      {
        label: t('删除分组'),
        icon: icon('trash'),
        danger: true,
        act: () =>
          confirmDialog({
            title: t('从工作区里删除「{0}」？', escapeHtml(grpName)),
            message: t('会删除该分组下的所有标签页。只动这份工作区留档，已保存分组和已打开的分组不受影响。'),
            okLabel: t('删除'),
            onOk: () => savedManagerApi.onDeleteWorkspaceGroup(wsId, groupId)
          })
      }
    ]
    showCtxMenu(items, e.clientX, e.clientY)
  }

  const onWsCtx = (e: ReactMouseEvent, w: ManageWorkspaceView): void => {
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
    e.preventDefault()
    e.stopPropagation()
    const items: CtxItem[] = [
      { label: t('重命名'), icon: icon('edit'), act: () => beginRename('workspace', w.id, w.name) },
      { label: t('恢复工作区'), icon: icon('rotate-ccw'), act: () => savedManagerApi.onRestoreWorkspace(w.id) },
      { sep: true },
      { label: t('删除工作区'), icon: icon('trash'), danger: true, act: () => savedManagerApi.onDeleteWorkspace(w.id) }
    ]
    showCtxMenu(items, e.clientX, e.clientY)
  }

  // 点"会话数"徽标弹会话小列表；只列重命名过的会话
  const openTabSessionPicker = (anchor: HTMLElement, savedId: string, tabId: string): void => {
    const g = getManageGroupViews().find((x) => x.id === savedId)
    const tab = g?.tabs.find((x) => x.id === tabId)
    if (!tab || tab.sessions.length < 2) return
    const named = tab.sessions.filter((s) => s.hasUserTitle)
    if (named.length === 0) return
    setSessPick({
      anchor,
      savedId,
      tabId,
      entries: named.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        source: s.source,
        ts: s.ts,
        isDefault: s.isActive
      }))
    })
  }

  const renderTabRow = (g: ManageGroupView, tab: ManageTabView, i: number, hl: Range[][], sess: Map<string, SessHit[]>) => {
    const n = tab.sessions.length
    // 徽标可点条件：会话数 > 1 且至少有一条重命名过的会话，否则退化为纯文本
    const named = tab.sessions.filter((s) => s.hasUserTitle).length
    const hits = sess.get(tab.id) ?? []
    return (
      <Fragment key={tab.id}>
        <div className="mg-tab" data-saved={g.id} data-tab={tab.id} onContextMenu={(e) => onTabCtx(e, g, tab)}>
          <span
            className="mg-tab-name"
            data-rename-tab={`${g.id}::${tab.id}`}
            title={t('右键有更多操作')}
            dangerouslySetInnerHTML={{ __html: highlightRanges(tab.name, hl[2 + i]) }}
            {...editableProps('tab', `${g.id}::${tab.id}`)}
          />
          <span className="mg-tab-meta">
            {n > 1 && named >= 1 ? (
              <button
                type="button"
                className="mg-sess-count"
                data-sess-picker={`${g.id}::${tab.id}`}
                title={t('选择要恢复的会话')}
                onClick={(e) => {
                  e.stopPropagation()
                  openTabSessionPicker(e.currentTarget, g.id, tab.id)
                }}
              >
                {t('{0} 会话', n) + ' ▾'}
              </button>
            ) : (
              t('{0} 会话', n)
            )}
            {tab.lastTs ? ` · ${formatTs(tab.lastTs)}` : ''}
          </span>
          <button
            className="mg-btn mg-tab-restore"
            data-tab-restore={`${g.id}::${tab.id}`}
            title={t('恢复该标签页到当前工作区')}
            onClick={() => savedManagerApi.onRestoreOneTab(g.id, tab.id)}
            dangerouslySetInnerHTML={{ __html: icon('rotate-ccw', { size: 13 }) }}
          />
        </div>
        {hits.map((h) => (
          <div
            key={h.sessionId}
            className="mg-sess-hit"
            data-sess-restore={`${g.id}::${tab.id}::${h.sessionId}`}
            title={t('恢复该标签页并打开此会话')}
            onClick={() => savedManagerApi.onRestoreTabAtSession(g.id, tab.id, h.sessionId)}
            dangerouslySetInnerHTML={{ __html: `<span class="mg-sess-hit-arrow">↳</span> ${highlightRanges(h.title, h.hl)}` }}
          />
        ))}
      </Fragment>
    )
  }

  const renderGroupRow = (g: ManageGroupView, hl: Range[][], forceExpand: boolean, sess: Map<string, SessHit[]>) => {
    // 搜索时强制展开；行上只留展开按钮，其余操作收进右键菜单
    const expandedNow = forceExpand || expanded.has(g.id)
    return (
      <div
        key={g.id}
        className={'mg-row is-visible' + (expandedNow ? ' is-expanded' : '')}
        data-saved-id={g.id}
        data-initial={nameInitial(g.name)}
        onContextMenu={(e) => onGroupCtx(e, g)}
      >
        <div className="mg-head-row" data-group-row={g.id} onClick={(e) => onHeadClick(e, g.id)}>
          <span className="mg-folder" dangerouslySetInnerHTML={{ __html: icon('folder') }} />
          <div className="mg-info">
            <div
              className="mg-name"
              data-rename-group={g.id}
              title={t('右键有更多操作，点击展开')}
              dangerouslySetInnerHTML={{ __html: highlightRanges(g.name, hl[0]) }}
              {...editableProps('group', g.id)}
            />
            <div className="mg-meta">
              {g.cwd ? shortPath(g.cwd) : <span className="path-placeholder">{t('(默认目录)')}</span>}
              {' · '}
              {t('{0} 个标签', g.tabs.length)}
              {' · '}
              {formatTs(g.savedAt)}
            </div>
          </div>
          <button
            className="mg-btn mg-toggle"
            data-toggle={g.id}
            title={expandedNow ? t('收起标签') : t('展开标签')}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpand(g.id)
            }}
            dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }}
          />
        </div>
        <div className="mg-tabs" hidden={!expandedNow}>
          {g.tabs.length === 0 ? (
            <div className="mg-tab-empty">{t('这个保存的分组里已没有标签。')}</div>
          ) : (
            g.tabs.map((tab, i) => renderTabRow(g, tab, i, hl, sess))
          )}
        </div>
      </div>
    )
  }

  const renderWsRow = (w: ManageWorkspaceView, hl: Range[][], forceExpand: boolean) => {
    const expandedNow = forceExpand || expanded.has(w.id)
    return (
      <div
        key={w.id}
        className={'mg-row is-visible' + (expandedNow ? ' is-expanded' : '')}
        data-ws-id={w.id}
        data-initial={nameInitial(w.name)}
        onContextMenu={(e) => onWsCtx(e, w)}
      >
        <div className="mg-head-row" data-ws-row={w.id} onClick={(e) => onHeadClick(e, w.id)}>
          <span className="mg-folder" dangerouslySetInnerHTML={{ __html: icon('layers') }} />
          <div className="mg-info">
            <div
              className="mg-name"
              title={t('右键有更多操作，点击展开')}
              dangerouslySetInnerHTML={{ __html: highlightRanges(w.name, hl[0]) }}
              {...editableProps('workspace', w.id)}
            />
            <div className="mg-meta">
              {t('{0} 个分组', w.groupCount)}
              {' · '}
              {t('{0} 个标签', w.tabCount)}
              {' · '}
              {formatTs(w.savedAt)}
            </div>
          </div>
          <button
            className="mg-btn mg-toggle"
            data-ws-toggle={w.id}
            title={expandedNow ? t('收起分组') : t('展开分组')}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpand(w.id)
            }}
            dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }}
          />
        </div>
        <div className="mg-tabs" hidden={!expandedNow}>
          {w.groups.length === 0 ? (
            <div className="mg-tab-empty">{t('这个工作区快照里没有分组。')}</div>
          ) : (
            w.groups.map((grp) => (
              <div
                key={grp.id}
                className="mg-tab mg-ws-grp"
                data-ws-grp={`${w.id}::${grp.id}`}
                onContextMenu={(e) => onWsGrpCtx(e, w.id, grp.id, grp.name)}
              >
                <span className="mg-ws-grp-ic" dangerouslySetInnerHTML={{ __html: icon('folder', { size: 13 }) }} />
                <span className="mg-tab-name">{grp.name}</span>
                <span className="mg-tab-meta">
                  {grp.cwd ? shortPath(grp.cwd) : <span className="path-placeholder">{t('(默认目录)')}</span>}
                  {' · '}
                  {t('{0} 个标签', grp.tabCount)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  const q = searchQuery.trim()
  let subText = ''
  let placeholder = ''
  let rowsNode: ReactNode = null
  let empty: { title: string; sub: string } | null = null
  let initials: string[] = []

  if (isOpen) {
    if (activeTab === 'workspaces') {
      subText = t('整份工作区快照：点击展开分组，右键可重命名 / 恢复 / 删除。')
      placeholder = t('搜索：工作区名（支持模糊匹配）')
      const all = getManageWorkspaceViews()
      const list: Array<{ w: ManageWorkspaceView; hl: Range[][] }> = q
        ? all
            .map((w) => {
              const r = fuzzySearch(q, [w.name])
              return r ? { w, hl: r.highlights, score: r.score } : null
            })
            .filter((x): x is { w: ManageWorkspaceView; hl: Range[][]; score: number } => !!x)
            .sort((a, b) => b.score - a.score)
        : all.map((w) => ({ w, hl: [] as Range[][] }))
      if (list.length === 0) {
        empty = {
          title: q ? t('没有匹配的工作区。') : t('还没有已保存的工作区。'),
          sub: q ? t('换个关键词试试，或清空搜索。') : t('在左侧「工作区」区空白处右键「保存该工作区」。')
        }
      } else {
        rowsNode = list.map(({ w, hl }) => renderWsRow(w, hl, !!q))
        initials = list.map(({ w }) => nameInitial(w.name))
      }
    } else {
      subText = t('按名称自动排序。点击展开标签，右键可重命名 / 恢复 / 删除。')
      placeholder = t('搜索：分组名 / 路径 / 标签名 / 会话名（支持模糊匹配）')
      const list = matchGroups(getManageGroupViews(), q)
      if (list.length === 0) {
        empty = {
          title: q ? t('没有匹配的分组。') : t('还没有已保存的分组。'),
          sub: q ? t('换个关键词试试，或清空搜索。') : t('右键打开的分组「保存分组」就会出现在这里。')
        }
      } else {
        rowsNode = list.map(({ g, hl, sess }) => renderGroupRow(g, hl, !!q, sess))
        initials = list.map(({ g }) => nameInitial(g.name))
      }
    }
  }

  // A~Z 跳转条：只点亮出现过的首字母，数字/符号开头归到 '#'
  const have = new Set(initials)
  const letters = [...(have.has('#') ? ['#'] : []), ...'abcdefghijklmnopqrstuvwxyz']
  const onAzClick = (ch: string): void => {
    if (!have.has(ch)) return
    bodyRef.current?.querySelector(`.mg-row[data-initial="${ch}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // mousedown 与 click 都落在 scrim 自身才关闭，防止 modal 内选文字拖出被误判
  const onScrimDown = (e: ReactMouseEvent): void => {
    downOnScrimRef.current = e.target === e.currentTarget
  }
  const onScrimClick = (e: ReactMouseEvent): void => {
    if (e.target === e.currentTarget && downOnScrimRef.current) closeSavedManager()
    downOnScrimRef.current = false
  }

  return (
    <div id="manageScrim" className="scrim" hidden={!isOpen} onMouseDown={onScrimDown} onClick={onScrimClick}>
      {isOpen && (
        <div className="modal modal-manage" role="dialog" aria-modal="true" aria-labelledby="mg-title">
          <div className="mg-head">
            <div>
              <h2 id="mg-title">{t('分组/工作区管理')}</h2>
              <p className="sub" id="mg-sub">
                {subText}
              </p>
            </div>
            <input
              id="mg-search"
              className="mg-search"
              type="search"
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              ref={searchRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button id="mg-close" className="mg-close-btn" type="button" aria-label={t('关闭')} onClick={() => closeSavedManager()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="mg-tabbar" role="tablist">
            <button
              className={'mg-tab-btn' + (activeTab === 'groups' ? ' active' : '')}
              data-mg-tab="groups"
              type="button"
              role="tab"
              onClick={() => switchTab('groups')}
            >
              {t('已保存分组')}
            </button>
            <button
              className={'mg-tab-btn' + (activeTab === 'workspaces' ? ' active' : '')}
              data-mg-tab="workspaces"
              type="button"
              role="tab"
              onClick={() => switchTab('workspaces')}
            >
              {t('已保存工作区')}
            </button>
          </div>
          <div className="mg-body-wrap">
            <div className="mg-az" id="mg-az" aria-label={t('按首字母跳转')}>
              {letters.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  className={'mg-az-letter' + (have.has(ch) ? '' : ' disabled')}
                  data-az={ch}
                  onClick={() => onAzClick(ch)}
                >
                  {ch === '#' ? '#' : ch.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mg-main">
              <div className="mg-body" id="mg-body" ref={bodyRef}>
                {rowsNode}
              </div>
              <div className="mg-empty" id="mg-empty" hidden={!empty}>
                <div>{empty?.title}</div>
                <div className="sub">{empty?.sub}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {sessPick &&
        createPortal(
          <SessPickFloat
            anchor={sessPick.anchor}
            entries={sessPick.entries}
            title={t('选择要恢复的会话')}
            onPick={(sid) => savedManagerApi.onRestoreTabAtSession(sessPick.savedId, sessPick.tabId, sid)}
            onClose={() => setSessPick(null)}
          />,
          document.body
        )}
    </div>
  )
}
