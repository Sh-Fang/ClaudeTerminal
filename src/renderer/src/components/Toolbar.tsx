import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import {
  getToolbarCtx,
  getGroupViews,
  getActiveTabId,
  getSettings,
  isCcTab,
  activateTab,
  closeTab,
  renameTab,
  promptNewTabInGroup,
  newGroup,
  openTabCtx,
  openTabMemoEditor,
  openSessionCtx,
  startCcInActiveTab,
  switchSession,
  moveTabWithinGroup,
  setTabDragData,
  handleTabDragEnd,
  isTabDragOver,
  handleTabDrop,
  TAB_DND_MIME
} from '../controller'
import { openSettings, openSavedManager, showMemoTip, hideMemoTip } from '../state/overlays'
import { formatTs, sessionTitle, srcLabel, statusLabel } from '../lib/format'
import { icon } from '../svg-icons'
import { t } from '../i18n'
import type { TerminalTab, SessionRecord, TabStatus } from '../terminal-tab'

// 当前会话：优先按 activeSessionId 找，找不到退回栈顶
function currentSession(tab: TerminalTab): SessionRecord | undefined {
  if (!tab.activeSessionId) return tab.sessions[tab.sessions.length - 1]
  return (
    tab.sessions.find((s) => s.sessionId === tab.activeSessionId) ??
    tab.sessions[tab.sessions.length - 1]
  )
}

// 行内改名：名字 span 临时置为 contentEditable；commit 后 renameTab 触发 rev bump 重渲染，
// 取消/空值手动还原旧文案。
function startInlineRename(tabId: string, el: HTMLSpanElement): void {
  const old = el.textContent ?? ''
  el.contentEditable = 'true'
  el.focus()
  // 光标 collapse 到末尾（不全选）
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  const commit = (cancel: boolean): void => {
    el.contentEditable = 'false'
    el.removeEventListener('blur', onBlur)
    el.removeEventListener('keydown', onKey)
    const v = (el.textContent || '').trim()
    if (cancel || !v) {
      el.textContent = old
      return
    }
    if (v !== old) {
      renameTab(tabId, v)
    } else {
      el.textContent = old
    }
  }
  const onBlur = (): void => commit(false)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      commit(true)
    }
  }
  el.addEventListener('blur', onBlur)
  el.addEventListener('keydown', onKey)
}

// 「+」：在活动标签所属分组内新建标签；无活动标签退回新建分组
function addTabInActiveGroup(): void {
  const activeTabId = getActiveTabId()
  const groups = getGroupViews()
  const g = activeTabId ? groups.find((x) => x.tabs.some((tb) => tb.id === activeTabId)) : null
  if (g) promptNewTabInGroup(g.id)
  else newGroup()
}

export function Toolbar() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const [menuOpen, setMenuOpen] = useState(false)
  // 标签条 chip 同分组内拖动排序
  const dragChipRef = useRef<{ tabId: string; groupId: string } | null>(null)
  const [dragChipId, setDragChipId] = useState<string | null>(null)
  const [chipDropMark, setChipDropMark] = useState<{ id: string; before: boolean } | null>(null)

  const cur = getToolbarCtx()
  const groups = getGroupViews()
  const activeTabId = getActiveTabId()

  // 无活动标签 → 强制收起会话菜单
  const hasCtx = cur != null
  useEffect(() => {
    if (!hasCtx) setMenuOpen(false)
  }, [hasCtx])

  // 点在 .session-menu / .session-select 之外才关下拉
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      const el = e.target as HTMLElement
      if (!el.closest('.session-menu') && !el.closest('.session-select')) setMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [menuOpen])

  const tab = cur?.tab
  const st = (tab?.status ?? 'idle') as TabStatus
  const curSess = tab ? currentSession(tab) : undefined
  // "启动 CC"显示条件：没勾自动启动且 cc 进程不活跃（用 ccActive：cc 退出后按钮要回来）
  const pureNonCc = tab != null && !tab.autoLaunchCC && !tab.ccActive
  // 水平标签栏时整条 .toolbar 被 CSS 隐藏，会话菜单要挂到 .tabstrip 下才弹得出来
  const horizontal = getSettings().tabBarMode === 'horizontal'

  // 会话栈下拉菜单：垂直模式挂 .toolbar、水平模式挂 .tabstrip
  const sessionMenu = (
    <div className={'session-menu' + (menuOpen ? ' open' : '')} id="sessionMenu">
      <div className="menu-eyebrow">{t('本标签的会话（栈顶 = 当前）')}</div>
      <div id="sessList">
        {tab &&
          (tab.sessions.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--mute)' }}>
              {t('没有会话记录。激活标签后 cc 会自动创建首个会话。')}
            </div>
          ) : (
            // 倒序展示，栈顶在最上面
            [...tab.sessions].reverse().map((s) => {
              const isCurrent = s.sessionId === tab.activeSessionId
              return (
                <div
                  key={s.sessionId}
                  className={'sess-item' + (isCurrent ? ' current' : '')}
                  data-session-id={s.sessionId}
                  onClick={() => {
                    setMenuOpen(false)
                    if (!isCurrent) switchSession(s.sessionId)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openSessionCtx(s.sessionId, e.clientX, e.clientY)
                  }}
                >
                  <span className="sdot"></span>
                  <div className="sess-body">
                    <div className="sess-title">{sessionTitle(s, tab.sessions)}</div>
                    <div className="sess-meta">
                      {formatTs(s.lastTs || s.createdAt)} · <span className="src">{srcLabel(s.source)}</span> ·{' '}
                      {s.sessionId.slice(0, 8)}
                      {isCurrent && (
                        <>
                          {' '}
                          · <span className="cur">{t('当前')}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          ))}
      </div>
      <div className="menu-foot">
        <span className="dot">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        <span>
          {t('终端里')} <code>/clear</code> {t('会自动在此新增一条会话')}
        </span>
      </div>
    </div>
  )

  return (
    <>
      {/* 水平标签栏：仅 tabBarMode=horizontal 时显示，平铺所有分组的标签（仅显示层扁平化） */}
      <div
        className="tabstrip"
        id="tabstrip"
        // 跨窗口标签拖入：整条标签条都是 drop 目标
        onDragOver={(e) => {
          if (isTabDragOver(e.dataTransfer)) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!e.dataTransfer?.types.includes(TAB_DND_MIME)) return
          e.preventDefault()
          handleTabDrop(e.dataTransfer)
        }}
      >
        <div className="tabstrip-list" id="tabstripList">
          {groups.length === 0 ? (
            <div className="tabstrip-empty">{t('没有打开的标签')}</div>
          ) : (
            groups.flatMap((g) =>
              g.tabs.map((tb) => {
                const cst = (tb.status ?? 'idle') as TabStatus
                // dirty 点与 isGroupDirty 过滤条件对齐：纯 pwsh tab 不显示
                const showDirty = tb.dirty && isCcTab(tb)
                const dotTitle = tb.note ? t('{0}：{1}', statusLabel(cst), tb.note) : statusLabel(cst)
                return (
                  <div
                    key={tb.id}
                    className={
                      'tabchip' +
                      (activeTabId === tb.id ? ' active' : '') +
                      (dragChipId === tb.id ? ' dragging' : '') +
                      (chipDropMark?.id === tb.id ? (chipDropMark.before ? ' drop-before' : ' drop-after') : '')
                    }
                    data-t={tb.id}
                    // hover 显示所属分组 / 路径
                    title={g.cwd ? `${g.name} · ${g.cwd}` : g.name}
                    draggable
                    onDragStart={(e) => {
                      setTabDragData(e, tb.id)
                      dragChipRef.current = { tabId: tb.id, groupId: g.id }
                      setDragChipId(tb.id)
                    }}
                    onDragEnd={(e) => {
                      dragChipRef.current = null
                      setDragChipId(null)
                      setChipDropMark(null)
                      handleTabDragEnd(e, tb.id)
                    }}
                    // 同分组内拖动排序（左半 = 插到前面）；跨分组/跨窗口冒泡给容器
                    onDragOver={(e) => {
                      const d = dragChipRef.current
                      if (!d || d.tabId === tb.id || d.groupId !== g.id) return
                      e.preventDefault()
                      e.stopPropagation()
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                      const rect = e.currentTarget.getBoundingClientRect()
                      const before = e.clientX < rect.left + rect.width / 2
                      setChipDropMark((prev) =>
                        prev && prev.id === tb.id && prev.before === before ? prev : { id: tb.id, before }
                      )
                    }}
                    onDragLeave={(e) => {
                      if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
                      setChipDropMark((prev) => (prev && prev.id === tb.id ? null : prev))
                    }}
                    onDrop={(e) => {
                      const d = dragChipRef.current
                      if (!d || d.groupId !== g.id) return
                      e.preventDefault()
                      e.stopPropagation()
                      const before = chipDropMark != null && chipDropMark.id === tb.id && chipDropMark.before
                      setChipDropMark(null)
                      moveTabWithinGroup(d.tabId, tb.id, before)
                    }}
                    onClick={() => activateTab(tb.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openTabCtx(tb.id, e.clientX, e.clientY)
                    }}
                    onDoubleClick={(e) => {
                      const nameEl = e.currentTarget.querySelector('.tabchip-name') as HTMLSpanElement | null
                      if (nameEl) startInlineRename(tb.id, nameEl)
                    }}
                  >
                    {tb.memo != null && (
                      // 便签图标：点开编辑弹窗，hover 圆角气泡预览备注开头
                      <span
                        className="memo-ic"
                        data-memo={tb.id}
                        title=""
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          openTabMemoEditor(tb.id, r.left, r.bottom + 6)
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onMouseEnter={(e) => {
                          if (!tb.memo?.trim()) return
                          const r = e.currentTarget.getBoundingClientRect()
                          showMemoTip(tb.memo, r.left, r.bottom + 6)
                        }}
                        onMouseLeave={() => hideMemoTip()}
                        dangerouslySetInnerHTML={{ __html: icon('sticky-note', { size: 11 }) }}
                      />
                    )}
                    <span className={`st-dot st-${cst}`} title={dotTitle}></span>
                    <span className="tabchip-name">{tb.name}</span>
                    {showDirty && <span className="trow-dirty" title={t('有未保存改动')}></span>}
                    <span
                      className="tabchip-close"
                      data-close={tb.id}
                      title={t('关闭标签')}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tb.id)
                      }}
                      dangerouslySetInnerHTML={{ __html: icon('close', { size: 11, stroke: 2 }) }}
                    />
                  </div>
                )
              })
            )
          )}
        </div>
        <button
          className="tabstrip-add"
          id="tabstripAdd"
          type="button"
          title={t('在当前分组新建标签')}
          aria-label={t('新建标签')}
          onClick={addTabInActiveGroup}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {/* 水平模式下会话/管理/设置以图标并入标签条右侧 */}
        {horizontal && (
          <>
            <button
              className="tool-icon-btn"
              type="button"
              title={t('切换会话')}
              aria-label={t('切换会话')}
              disabled={!cur}
              onClick={(e) => {
                e.stopPropagation()
                if (!cur) return
                setMenuOpen((v) => !v)
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
            <button
              className="tool-icon-btn"
              type="button"
              title={t('分组 / 工作区管理')}
              aria-label={t('分组 / 工作区管理')}
              onClick={() => openSavedManager('groups')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 2 10 5-10 5L2 7z" />
                <path d="m2 12 10 5 10-5" />
                <path d="m2 17 10 5 10-5" />
              </svg>
            </button>
            <button
              className="tool-icon-btn"
              type="button"
              title={t('设置')}
              aria-label={t('设置')}
              onClick={() => openSettings()}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {sessionMenu}
          </>
        )}
      </div>

      <div className="toolbar">
        <div className={'crumb' + (cur ? '' : ' is-empty')}>
          <span className="g" id="cbGroup">{cur ? cur.groupName : ''}</span>
          <span className="sep">›</span>
          <span className="t" id="cbTab">{tab ? tab.name : ''}</span>
          <span id="cbStatus">
            {tab && st !== 'idle' && (
              <span
                className={`status-pill sp-${st}`}
                title={tab.note ? t('{0}：{1}', statusLabel(st), tab.note) : statusLabel(st)}
              >
                <span className={`st-dot st-${st}`}></span>
                {statusLabel(st)}
              </span>
            )}
          </span>
          <button
            className={'start-cc-btn' + (pureNonCc ? ' show' : '')}
            id="startCcBtn"
            type="button"
            title={t('在当前 pwsh 会话中启动 Claude Code（等效命令 cct）')}
            onClick={() => startCcInActiveTab()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            <span>{t('启动 CC')}</span>
          </button>
        </div>
        <div className="spacer"></div>
        <div
          className={'session-select' + (cur ? '' : ' empty') + (menuOpen ? ' open' : '')}
          id="sessionSelect"
          title={t('切换会话')}
          onClick={(e) => {
            e.stopPropagation()
            if (!cur) return
            setMenuOpen((v) => !v)
          }}
        >
          <span className="clock">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span className="time" id="sessTime">
            {curSess ? formatTs(curSess.lastTs || curSess.createdAt) : ''}
          </span>
          <span className="title" id="sessTitle">
            {!cur ? t('（无活动标签）') : curSess ? sessionTitle(curSess, cur.tab.sessions) : t('（未创建会话）')}
          </span>
          <span className="caret">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </div>
        {/* 顶栏「分组/工作区管理」按钮，显隐由 CSS 控制 */}
        <button
          className="tool-icon-btn"
          id="manageTopBtn"
          title={t('分组 / 工作区管理')}
          aria-label={t('分组 / 工作区管理')}
          onClick={() => openSavedManager('groups')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 2 10 5-10 5L2 7z" />
            <path d="m2 12 10 5 10-5" />
            <path d="m2 17 10 5 10-5" />
          </svg>
        </button>
        <button
          className="tool-icon-btn"
          id="settingsBtn"
          title={t('设置')}
          aria-label={t('设置')}
          onClick={() => openSettings()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {!horizontal && sessionMenu}
      </div>
    </>
  )
}
