// 侧边栏：工作区分组列表 + 已保存快捷区 + 用量面板 + 拉条与收起把手。
// 数据全部来自 controller 的 getter，靠 useAppStore 的 rev 驱动重渲染。
import { useRef, useState } from 'react'
import type {
  DragEvent as RDragEvent,
  KeyboardEvent as RKeyboardEvent,
  MouseEvent as RMouseEvent
} from 'react'
import { useAppStore } from '../state/store'
import { openHistory, openSavedManager, showMemoTip, hideMemoTip } from '../state/overlays'
import { statusLabel, statusShort } from '../lib/format'
import { icon } from '../svg-icons'
import { t } from '../i18n'
import { UsagePanel } from './UsagePanel'
import type { GroupView } from '../controller'
import type { TerminalTab } from '../terminal-tab'
import type { TabStatus } from '../ui-helpers-types'
import {
  getGroupViews,
  getSavedViews,
  getSavedWorkspaceViews,
  getActiveTabId,
  getSettings,
  updateSettings,
  patchSettingsLive,
  persistSettings,
  refitActive,
  activateTab,
  closeTab,
  renameTab,
  toggleGroupCollapse,
  setAllGroupsCollapsed,
  openGroupCtx,
  openTabCtx,
  openTabMemoEditor,
  openWorkspacePaneCtx,
  promptNewTabInGroup,
  newGroup,
  reorderGroups,
  openRestoreSelect,
  restoreSavedWorkspace,
  locateActiveTab,
  moveTabWithinGroup,
  setTabDragData,
  handleTabDragEnd,
  isTabDragOver,
  handleTabDrop,
  TAB_DND_MIME
} from '../controller'

const ORDER: Record<TabStatus, number> = { error: 4, attention: 3, done: 2, busy: 1, idle: 0 }

// 分组头状态点取组内"最严重"的 tab 状态
function groupStatus(g: GroupView): TabStatus {
  let best: TabStatus = 'idle'
  for (const tab of g.tabs) {
    const s = (tab.status ?? 'idle') as TabStatus
    if (ORDER[s] > ORDER[best]) best = s
  }
  return best
}

export function Sidebar() {
  const rev = useAppStore((s) => s.rev)
  void rev

  const settings = getSettings()
  const groups = getGroupViews()
  const activeTabId = getActiveTabId()

  // 底部区当前展示：已保存分组 / 已保存工作区（不持久化）
  const [savedView, setSavedView] = useState<'groups' | 'workspaces'>('groups')
  // 行内重命名中的 tabId
  const [renamingTab, setRenamingTab] = useState<string | null>(null)
  // 分组拖动排序：正在拖的分组 id + 落点标记
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const [dropMark, setDropMark] = useState<{ id: string; before: boolean } | null>(null)
  const dragIdRef = useRef<string | null>(null)
  // 同分组内标签拖动排序；跨窗口拖入的标签 ref 为 null，自然落到容器级的迁移 drop
  const dragTabRef = useRef<{ tabId: string; groupId: string } | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [tabDropMark, setTabDropMark] = useState<{ id: string; before: boolean } | null>(null)

  const sidebarRef = useRef<HTMLElement | null>(null)
  const savedSectionRef = useRef<HTMLElement | null>(null)
  const sidebarResizerRef = useRef<HTMLDivElement | null>(null)
  const savedResizerRef = useRef<HTMLDivElement | null>(null)

  // 重命名会话期临时值：旧名 / 是否已提交（防 Enter 后 blur 二次提交）
  const renameOldRef = useRef('')
  const renameDoneRef = useRef(true)
  const renameElRef = useRef<HTMLSpanElement | null>(null)

  const startRename = (tabId: string, name: string): void => {
    renameOldRef.current = name
    renameDoneRef.current = false
    renameElRef.current = null
    setRenamingTab(tabId)
  }

  const commitRename = (tabId: string, el: HTMLSpanElement, cancel: boolean): void => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    const v = (el.textContent || '').trim()
    setRenamingTab(null)
    // 取消/空值/没改动直接丢弃：编辑 span 靠 key 整体重挂，旧文本自然还原
    if (!cancel && v && v !== renameOldRef.current) renameTab(tabId, v)
  }

  const onGroupDragStart = (e: RDragEvent<HTMLDivElement>, g: GroupView): void => {
    // 编辑中的标签名不抢拖动
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) {
      e.preventDefault()
      return
    }
    dragIdRef.current = g.id
    setDragGroupId(g.id)
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', g.id)
      const head = e.currentTarget.querySelector('.group-head') as HTMLElement | null
      if (head) e.dataTransfer.setDragImage(head, 8, 8)
    }
  }

  const onGroupDragOver = (e: RDragEvent<HTMLDivElement>, g: GroupView): void => {
    if (!dragIdRef.current || g.id === dragIdRef.current) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    setDropMark((prev) => (prev && prev.id === g.id && prev.before === before ? prev : { id: g.id, before }))
  }

  const onGroupDragLeave = (e: RDragEvent<HTMLDivElement>, g: GroupView): void => {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropMark((prev) => (prev && prev.id === g.id ? null : prev))
  }

  const onGroupDrop = (e: RDragEvent<HTMLDivElement>, g: GroupView): void => {
    const dragId = dragIdRef.current
    if (!dragId) return
    e.preventDefault()
    const before = dropMark != null && dropMark.id === g.id && dropMark.before
    setDropMark(null)
    if (g.id === dragId) return

    const order = groups.map((x) => x.id)
    const fromIdx = order.indexOf(dragId)
    if (fromIdx < 0) return
    order.splice(fromIdx, 1)
    let toIdx = order.indexOf(g.id)
    if (toIdx < 0) return
    if (!before) toIdx += 1
    order.splice(toIdx, 0, dragId)
    reorderGroups(order)
  }

  const onGroupDragEnd = (): void => {
    dragIdRef.current = null
    setDragGroupId(null)
    setDropMark(null)
  }

  // Sidebar 宽度拉条
  const onSidebarResizerDown = (e: RMouseEvent<HTMLDivElement>): void => {
    const s = getSettings()
    if (s.sidebarCollapsed) return
    e.preventDefault()
    document.body.classList.add('col-resizing')
    const resizer = sidebarResizerRef.current
    resizer?.classList.add('dragging')
    const startX = e.clientX
    const startW = s.sidebarWidth
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(180, Math.min(520, startW + (ev.clientX - startX)))
      patchSettingsLive({ sidebarWidth: w })
      // 拖动中直接写 CSS 变量即时反馈，拖完再落盘
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
    }
    const onUp = (): void => {
      document.body.classList.remove('col-resizing')
      resizer?.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      persistSettings()
      refitActive()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 已保存 ↔ 打开 之间的水平拉条：调 .side-saved 高度
  const onSavedResizerDown = (e: RMouseEvent<HTMLDivElement>): void => {
    const s = getSettings()
    if (s.savedCollapsed || s.sidebarCollapsed) return
    e.preventDefault()
    document.body.classList.add('row-resizing')
    const resizer = savedResizerRef.current
    resizer?.classList.add('dragging')
    const startY = e.clientY
    const startH = savedSectionRef.current?.getBoundingClientRect().height ?? 0
    const sidebarH = sidebarRef.current?.getBoundingClientRect().height ?? 0
    // 留 100px 给「打开的分组」，避免被挤没
    const minH = 80
    const maxH = Math.max(minH, sidebarH - 100)
    const onMove = (ev: MouseEvent): void => {
      const dy = startY - ev.clientY
      const h = Math.max(minH, Math.min(maxH, Math.round(startH + dy)))
      patchSettingsLive({ sidebarSavedHeight: h })
      document.documentElement.style.setProperty('--saved-h', `${h}px`)
    }
    const onUp = (): void => {
      document.body.classList.remove('row-resizing')
      resizer?.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      persistSettings()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 展开/收起全部共用一个按钮
  const allCollapsed = groups.length > 0 && groups.every((g) => g.collapsed)
  const toggleAllLabel = allCollapsed ? t('展开全部分组') : t('收起全部分组')

  const renderTabRow = (tab: TerminalTab, active: boolean, groupId: string) => {
    const st = (tab.status ?? 'idle') as TabStatus
    const isIdle = st === 'idle'
    const badgeText = isIdle ? t('{0}会话', tab.sessions.length) : statusShort(st)
    const badgeCls = isIdle ? '' : ` bs-${st}`
    const dotTitle = tab.note ? t('{0}：{1}', statusLabel(st), tab.note) : statusLabel(st)
    // dirty 点与 isGroupDirty 过滤条件对齐：纯 pwsh tab 没数据可保存，不显示
    const showDirty = tab.dirty && (tab.autoLaunchCC || tab.sessions.length > 0)
    const renaming = renamingTab === tab.id
    return (
      <div
        key={tab.id}
        className={
          'tab-row' +
          (active ? ' active' : '') +
          (dragTabId === tab.id ? ' dragging' : '') +
          (tabDropMark?.id === tab.id ? (tabDropMark.before ? ' drop-before' : ' drop-after') : '')
        }
        data-t={tab.id}
        // 跨窗口拖拽：拖出成新窗/拖到另一窗合并；stopPropagation 挡住冒泡到 .group 的分组重排
        draggable={!renaming}
        onDragStart={(e) => {
          e.stopPropagation()
          setTabDragData(e, tab.id)
          dragTabRef.current = { tabId: tab.id, groupId }
          setDragTabId(tab.id)
        }}
        onDragEnd={(e) => {
          e.stopPropagation()
          dragTabRef.current = null
          setDragTabId(null)
          setTabDropMark(null)
          handleTabDragEnd(e, tab.id)
        }}
        // 本窗口同组拖动才接住画插位线；跨分组/跨窗口冒泡给容器处理迁移
        onDragOver={(e) => {
          const d = dragTabRef.current
          if (!d || d.tabId === tab.id || d.groupId !== groupId) return
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const before = e.clientY < rect.top + rect.height / 2
          setTabDropMark((prev) =>
            prev && prev.id === tab.id && prev.before === before ? prev : { id: tab.id, before }
          )
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
          setTabDropMark((prev) => (prev && prev.id === tab.id ? null : prev))
        }}
        onDrop={(e) => {
          const d = dragTabRef.current
          if (!d || d.groupId !== groupId) return
          e.preventDefault()
          e.stopPropagation()
          const before = tabDropMark != null && tabDropMark.id === tab.id && tabDropMark.before
          setTabDropMark(null)
          moveTabWithinGroup(d.tabId, tab.id, before)
        }}
        onClick={(e) => {
          // 编辑中点击自身不切换激活
          if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return
          activateTab(tab.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          openTabCtx(tab.id, e.clientX, e.clientY)
        }}
        onDoubleClick={() => {
          if (renamingTab !== tab.id) startRename(tab.id, tab.name)
        }}
      >
        {tab.memo != null && (
          // 便签图标：点开编辑弹窗，hover 圆角气泡预览备注开头；stopPropagation 挡住行激活/改名
          <span
            className="memo-ic"
            data-memo={tab.id}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              openTabMemoEditor(tab.id, r.left, r.bottom + 6)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseEnter={(e) => {
              if (!tab.memo?.trim()) return
              const r = e.currentTarget.getBoundingClientRect()
              showMemoTip(tab.memo, r.left, r.bottom + 6)
            }}
            onMouseLeave={() => hideMemoTip()}
            dangerouslySetInnerHTML={{ __html: icon('sticky-note', { size: 12 }) }}
          />
        )}
        <span className={`st-dot st-${st}`} title={dotTitle}></span>
        {renaming ? (
          // 编辑态用独立 key 强制重挂，手输文本节点随元素丢弃，不污染 React 静态节点
          <span
            key="rename"
            className="trow-name"
            contentEditable
            suppressContentEditableWarning
            ref={(el) => {
              if (!el || renameElRef.current === el) return
              renameElRef.current = el
              el.textContent = renameOldRef.current
              el.focus()
              // 光标 collapse 到末尾（不全选）
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              const sel = window.getSelection()
              sel?.removeAllRanges()
              sel?.addRange(range)
            }}
            onBlur={(e) => commitRename(tab.id, e.currentTarget, false)}
            onKeyDown={(e: RKeyboardEvent<HTMLSpanElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename(tab.id, e.currentTarget, false)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                commitRename(tab.id, e.currentTarget, true)
              }
            }}
          />
        ) : (
          <span key="name" className="trow-name">
            {tab.name}
          </span>
        )}
        {showDirty && <span className="trow-dirty" title={t('有未保存改动')}></span>}
        <span className={'trow-badge' + badgeCls}>{badgeText}</span>
        <span className="trow-actions">
          <span
            className="trow-close"
            data-close={tab.id}
            title={t('关闭标签')}
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.id)
            }}
            dangerouslySetInnerHTML={{ __html: icon('close', { size: 12, stroke: 2 }) }}
          />
        </span>
      </div>
    )
  }

  const renderGroup = (g: GroupView) => {
    const gs = groupStatus(g)
    const cwdTitle = g.cwd ? g.cwd : t('使用用户主目录')
    const folderTitle = g.dirty ? t('有未保存的改动，右键「保存分组」') : ''
    const markCls =
      dropMark && dropMark.id === g.id ? (dropMark.before ? ' drop-before' : ' drop-after') : ''
    return (
      <div
        key={g.id}
        className={
          'group' + (g.collapsed ? ' collapsed' : '') + (dragGroupId === g.id ? ' dragging' : '') + markCls
        }
        draggable
        data-drag-id={g.id}
        onDragStart={(e) => onGroupDragStart(e, g)}
        onDragOver={(e) => onGroupDragOver(e, g)}
        onDragLeave={(e) => onGroupDragLeave(e, g)}
        onDrop={(e) => onGroupDrop(e, g)}
        onDragEnd={onGroupDragEnd}
      >
        <div
          className="group-head"
          data-g={g.id}
          onClick={() => toggleGroupCollapse(g.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            openGroupCtx(g.id, e.clientX, e.clientY)
          }}
        >
          <span
            className="group-caret"
            dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 12, stroke: 2.4 }) }}
          />
          <span
            className={'group-folder' + (g.dirty ? ' is-dirty' : '')}
            title={folderTitle}
            dangerouslySetInnerHTML={{ __html: g.dirty ? icon('folder-filled') : icon('folder') }}
          />
          <div className="group-meta">
            <div className="group-name">{g.name}</div>
            <div className="group-path" title={cwdTitle}>
              {g.cwd ? g.cwd : <span className="path-placeholder">{t('(默认目录)')}</span>}
            </div>
          </div>
          {gs !== 'idle' && (
            <span
              className={`st-dot st-${gs} grp-st`}
              title={t('组内有「{0}」的会话', statusLabel(gs))}
            ></span>
          )}
          <span className="group-count">{g.tabs.length}</span>
          <span className="group-actions">
            <span
              className="group-add"
              data-addtab={g.id}
              title={t('新建会话标签')}
              onClick={(e) => {
                e.stopPropagation()
                promptNewTabInGroup(g.id)
              }}
              dangerouslySetInnerHTML={{ __html: icon('plus', { size: 13, stroke: 2.2 }) }}
            />
            <span
              className="group-more"
              data-more={g.id}
              title={t('更多')}
              onClick={(e) => {
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                openGroupCtx(g.id, rect.right, rect.bottom)
              }}
              dangerouslySetInnerHTML={{ __html: icon('more-horizontal') }}
            />
          </span>
        </div>
        <div className="group-tabs">{g.tabs.map((tab) => renderTabRow(tab, activeTabId === tab.id, g.id))}</div>
      </div>
    )
  }

  const renderSavedList = () => {
    if (savedView === 'workspaces') {
      const workspaces = getSavedWorkspaceViews()
      if (workspaces.length === 0) {
        return <div className="side-empty">{t('上方「工作区」区空白处右键「保存该工作区」。')}</div>
      }
      // saved 行无右键菜单，左键即恢复
      return workspaces.map((w) => (
        <div
          key={w.id}
          className="saved-row"
          data-saved-ws={w.id}
          onClick={() => void restoreSavedWorkspace(w.id)}
        >
          <div className="saved-ic saved-ic-ws" dangerouslySetInnerHTML={{ __html: icon('layers') }} />
          <div className="saved-meta">
            <div className="saved-name">{w.name}</div>
            <div className="saved-sub">
              {t('{0} 个分组', w.groupCount)}
              {' · '}
              {t('{0} 个标签', w.tabCount)}
              {' · '}
              {w.savedAt}
            </div>
          </div>
        </div>
      ))
    }
    const saved = getSavedViews()
    if (saved.length === 0) {
      return <div className="side-empty">{t('右键分组「保存分组」可在此一键恢复。')}</div>
    }
    return saved.map((s) => (
      <div key={s.id} className="saved-row" data-saved={s.id} onClick={() => openRestoreSelect(s.id)}>
        <div className="saved-ic" dangerouslySetInnerHTML={{ __html: icon('rotate-ccw') }} />
        <div className="saved-meta">
          <div className="saved-name">{s.name}</div>
          <div className="saved-sub">
            {t('{0} 个标签', s.tabCount)}
            {' · '}
            {s.cwd ? s.cwd : <span className="path-placeholder">{t('(默认目录)')}</span>}
            {' · '}
            {s.savedAt}
          </div>
        </div>
      </div>
    ))
  }

  return (
    <>
      <aside className={'sidebar' + (settings.sidebarCollapsed ? ' collapsed' : '')} id="sidebar" ref={sidebarRef}>
        <section
          className="side-section side-open"
          onContextMenu={(e) => {
            // 右键命中分组头/标签行时交给行级菜单，其余弹「保存该工作区」
            const tgt = e.target as HTMLElement
            if (tgt.closest('[data-t]') || tgt.closest('[data-g]')) return
            e.preventDefault()
            openWorkspacePaneCtx(e.clientX, e.clientY)
          }}
        >
          <div className="side-section-label">
            {t('工作区')}
            <span className="line"></span>
            <button
              id="newGroupBtn"
              className="side-head-btn"
              type="button"
              title={t('新建分组')}
              aria-label={t('新建分组')}
              onClick={() => void newGroup()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              id="locateActiveBtn"
              className="side-head-btn"
              type="button"
              title={t('定位当前标签')}
              aria-label={t('定位当前标签')}
              onClick={() => locateActiveTab()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                <circle cx="12" cy="12" r="7" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            </button>
            <button
              id="toggleAllBtn"
              className="side-head-btn"
              type="button"
              title={toggleAllLabel}
              aria-label={toggleAllLabel}
              disabled={groups.length === 0}
              onClick={() => {
                if (groups.length === 0) return
                setAllGroupsCollapsed(!allCollapsed)
              }}
              dangerouslySetInnerHTML={{
                __html: icon(allCollapsed ? 'expand-all' : 'collapse-all', { size: 13 })
              }}
            />
            <button
              id="historyOpenBtn"
              className="side-head-btn"
              type="button"
              title={t('标签历史（7 天内）')}
              aria-label={t('标签历史')}
              onClick={() => openHistory()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
            <button
              id="sidebarCollapseBtn"
              className="side-head-btn"
              type="button"
              title={t('收起侧边栏')}
              aria-label={t('收起侧边栏')}
              onClick={() => {
                updateSettings({ ...getSettings(), sidebarCollapsed: true })
                // 等收起动画走完再 refit 终端尺寸
                setTimeout(() => refitActive(), 180)
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m15 6-6 6 6 6" />
              </svg>
            </button>
          </div>
          <div
            className="side-open-scroll"
            // 跨窗口标签拖入：整个工作区滚动区都是 drop 目标
            onDragOver={(e) => {
              if (isTabDragOver(e.dataTransfer)) e.preventDefault()
            }}
            onDrop={(e) => {
              if (!e.dataTransfer?.types.includes(TAB_DND_MIME)) return
              e.preventDefault()
              handleTabDrop(e.dataTransfer)
            }}
          >
            <div id="groupList">
              {groups.length === 0 ? (
                <div className="side-empty">{t('工作区为空')}</div>
              ) : (
                groups.map((g) => renderGroup(g))
              )}
            </div>
          </div>
        </section>

        {/* 横向拉条调整「已保存」区高度；折叠态 .disabled 禁用避免误拖 */}
        <div
          id="savedResizer"
          ref={savedResizerRef}
          className={'saved-resizer' + (settings.savedCollapsed ? ' disabled' : '')}
          title={t('拖动调整已保存区高度')}
          aria-hidden="true"
          onMouseDown={onSavedResizerDown}
        ></div>

        {/* 已保存区：分组与工作区分开展示，管理入口进弹窗 */}
        <section
          className={'side-section side-saved' + (settings.savedCollapsed ? ' collapsed' : '')}
          id="savedSection"
          ref={savedSectionRef}
        >
          <div className="side-section-label saved-head">
            <button
              className="saved-toggle"
              id="savedToggle"
              type="button"
              title={t('收起 / 展开')}
              onClick={() => updateSettings({ ...getSettings(), savedCollapsed: !getSettings().savedCollapsed })}
            >
              <span className="saved-caret">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
            <span className="saved-view-switch" id="savedViewSwitch" role="tablist">
              <button
                className={'sv-item' + (savedView === 'groups' ? ' active' : '')}
                data-view="groups"
                type="button"
                role="tab"
                onClick={() => setSavedView('groups')}
              >
                {t('分组')}
              </button>
              <span className="sv-sep">/</span>
              <button
                className={'sv-item' + (savedView === 'workspaces' ? ' active' : '')}
                data-view="workspaces"
                type="button"
                role="tab"
                onClick={() => setSavedView('workspaces')}
              >
                {t('工作区||列表')}
              </button>
            </span>
            <span className="line"></span>
            <button
              id="manageSavedBtn"
              className="side-head-btn"
              type="button"
              title={t('管理已保存的分组/工作区')}
              aria-label={t('展开管理')}
              onClick={() => openSavedManager(savedView)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
          <div className="side-saved-body">
            <div id="savedList">{renderSavedList()}</div>
          </div>
        </section>

        <UsagePanel />

        <div
          id="sidebarResizer"
          ref={sidebarResizerRef}
          className="sidebar-resizer"
          title={t('拖动调整宽度')}
          aria-hidden="true"
          onMouseDown={onSidebarResizerDown}
        ></div>
      </aside>

      {/* 收起后的悬浮把手：点击展开侧边栏 */}
      <div
        id="sidebarHandle"
        className="sidebar-handle"
        hidden={!settings.sidebarCollapsed}
        title={t('展开侧边栏（hover 预览）')}
        onClick={() => {
          updateSettings({ ...getSettings(), sidebarCollapsed: false })
          setTimeout(() => refitActive(), 180)
        }}
      >
        <span className="sh-ic">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </span>
        <span className="sh-chevron">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </div>
    </>
  )
}
