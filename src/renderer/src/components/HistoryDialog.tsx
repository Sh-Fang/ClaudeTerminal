// 标签历史弹窗（原 history-manager.ts 的 React 版）：仿浏览器历史的左 nav 时间分组 +
// 右列表 + 底部按时间段清空。数据源是主进程 tabHistoryList()（已按 lastSeenAt 倒序）；
// 按"今天 / 昨天 / 更早"切桶，左侧 nav 切换右侧列表。点行/恢复按钮 = 恢复成 live tab；
// 垃圾桶 = 单条删除。开合订阅 overlays store（openHistory/closeHistory）。

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { icon } from '../svg-icons'
import { t } from '../i18n'
import { useOverlays, closeHistory, confirmDialog } from '../state/overlays'
import { escapeHtml, formatTs, shortPath, fuzzySearch, highlightRanges, type Range } from '../lib/format'
import { restoreFromHistory } from '../controller'
import type { HistoryEntry } from '../app-types'

type Bucket = 'today' | 'yesterday' | 'earlier'
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'earlier', label: '更早' }
]

function startOfDay(d: Date): number {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c.getTime()
}

function bucketOf(iso: string, todayStartMs: number, yesterdayStartMs: number): Bucket {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return 'earlier'
  if (ts >= todayStartMs) return 'today'
  if (ts >= yesterdayStartMs) return 'yesterday'
  return 'earlier'
}

function regroup(entries: HistoryEntry[]): Record<Bucket, HistoryEntry[]> {
  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86_400_000
  const buckets: Record<Bucket, HistoryEntry[]> = { today: [], yesterday: [], earlier: [] }
  for (const e of entries) buckets[bucketOf(e.lastSeenAt, todayStart, yesterdayStart)].push(e)
  return buckets
}

function firstNonEmptyBucket(grouped: Record<Bucket, HistoryEntry[]>): Bucket | null {
  for (const b of BUCKETS) if (grouped[b.key].length > 0) return b.key
  return null
}

export function HistoryDialog() {
  const isOpen = useOverlays((s) => s.historyOpen)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [activeBucket, setActiveBucket] = useState<Bucket>('today')
  const [searchQuery, setSearchQuery] = useState('')
  const downOnScrimRef = useRef(false)

  const grouped = regroup(entries)

  // 打开时拉最近 7 天历史，默认跳到第一个非空桶（用户最关心今天，但今天为空就跳昨天）。
  // 同时聚焦搜索框——打开即可直接敲字搜索，不用先用鼠标点进输入框。
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!isOpen) return
    let alive = true
    setSearchQuery('')
    searchRef.current?.focus()
    void window.term.tabHistoryList().then((list) => {
      if (!alive) return
      setEntries(list)
      setActiveBucket(firstNonEmptyBucket(regroup(list)) ?? 'today')
    })
    return () => {
      alive = false
    }
  }, [isOpen])

  // 单条删除 / 清空后重拉。当前 active 桶被删空就跳到第一个非空桶；
  // 都空就保持原 active（让 empty 提示展示）
  const refresh = async (): Promise<void> => {
    const list = await window.term.tabHistoryList()
    setEntries(list)
    const g = regroup(list)
    setActiveBucket((prev) => (g[prev].length === 0 ? (firstNonEmptyBucket(g) ?? prev) : prev))
  }

  // 取过滤后的桶列表；空 query 直接返回原桶。
  // 命中项 + 每项高亮；有搜索时按匹配分倒序，无搜索时保持原（时间）序。
  // 路径用完整串匹配（保留全路径可搜），只高亮分组名/标签名，路径不高亮。
  const filtered = (b: Bucket, query = searchQuery): Array<{ e: HistoryEntry; hl: Range[][] }> => {
    const q = query.trim()
    if (!q) return grouped[b].map((e) => ({ e, hl: [] as Range[][] }))
    return grouped[b]
      .map((e) => {
        const r = fuzzySearch(q, [e.groupName, e.tabName, e.cwd], [3, 3, 1])
        return r ? { e, hl: r.highlights, score: r.score } : null
      })
      .filter((x): x is { e: HistoryEntry; hl: Range[][]; score: number } => !!x)
      .sort((a, b2) => b2.score - a.score)
  }

  // 输入搜索词后：当前 active 桶被过滤空了就跳到第一个仍有命中的桶，
  // 没有任何命中则保留当前 active（让 empty 提示展示）。
  const onSearchInput = (v: string): void => {
    setSearchQuery(v)
    if (filtered(activeBucket, v).length > 0) return
    for (const b of BUCKETS) {
      if (filtered(b.key, v).length > 0) {
        setActiveBucket(b.key)
        return
      }
    }
  }

  // Esc：有搜索词时先清空搜索（并按需跳桶），再次 Esc 才关弹窗
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (searchQuery) {
        setSearchQuery('')
        if (grouped[activeBucket].length === 0) {
          const first = firstNonEmptyBucket(grouped)
          if (first) setActiveBucket(first)
        }
        return
      }
      closeHistory()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // grouped 由 entries 派生，这里用 entries 声明依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, searchQuery, entries, activeBucket])

  const onDelete = (entry: HistoryEntry): void => {
    confirmDialog({
      title: t('删除这条历史？'),
      message: t('将从历史里删除「<b>{0}</b>」，已打开的标签不受影响。', `${escapeHtml(entry.groupName)} · ${escapeHtml(entry.tabName)}`),
      okLabel: t('删除'),
      onOk: async () => {
        await window.term.tabHistoryDelete(entry.tabId)
        await refresh()
      }
    })
  }

  const onClear = (): void => {
    const list = grouped[activeBucket]
    if (list.length === 0) return
    const bucketLabel = t(BUCKETS.find((b) => b.key === activeBucket)?.label ?? '')
    const ids = list.map((e) => e.tabId)
    confirmDialog({
      title: t('清空{0}的历史？', bucketLabel),
      message: t('将清空<b>{0}</b>的 <b>{1}</b> 条历史记录，已打开的标签不受影响。', bucketLabel, ids.length),
      okLabel: t('清空'),
      onOk: async () => {
        await window.term.tabHistoryDeleteMany(ids)
        await refresh()
      }
    })
  }

  const renderRow = ({ e, hl }: { e: HistoryEntry; hl: Range[][] }) => {
    const sessionCount = e.sessions?.length ?? 0
    const sessionMeta = sessionCount > 0 ? t('{0} 个会话', sessionCount) : t('空会话')
    return (
      <div
        key={e.tabId}
        className="mg-row is-visible"
        data-tab-id={e.tabId}
        // 行内任意位置点击（非按钮）= 恢复。不关弹窗：后台恢复，
        // 用户可能连着恢复多条（与「分组/工作区管理」一致）
        onClick={() => restoreFromHistory(e)}
      >
        <div className="mg-head-row">
          <span className="mg-folder" dangerouslySetInnerHTML={{ __html: icon('folder') }} />
          <div className="mg-info">
            <div
              className="mg-name"
              dangerouslySetInnerHTML={{
                __html: `${highlightRanges(e.groupName, hl[0])} <span class="mg-group-name">· ${highlightRanges(e.tabName, hl[1])}</span>`
              }}
            />
            <div className="mg-meta">
              {e.cwd ? shortPath(e.cwd) : <span className="path-placeholder">{t('(默认目录)')}</span>}
              {' · '}
              {sessionMeta}
              {' · '}
              {formatTs(e.lastSeenAt)}
            </div>
          </div>
          <button
            className="mg-btn"
            data-restore={e.tabId}
            title={t('恢复成新标签')}
            onClick={(ev) => {
              ev.stopPropagation()
              restoreFromHistory(e)
            }}
            dangerouslySetInnerHTML={{ __html: icon('rotate-ccw', { size: 14 }) }}
          />
          <button
            className="mg-btn mg-danger"
            data-delete={e.tabId}
            title={t('从历史里删除此条')}
            onClick={(ev) => {
              ev.stopPropagation()
              onDelete(e)
            }}
            dangerouslySetInnerHTML={{ __html: icon('trash', { size: 14 }) }}
          />
        </div>
      </div>
    )
  }

  // ─── 列表 / 空态 / 清空按钮的派生数据 ────────────────────────────
  const q = searchQuery.trim()
  const list = filtered(activeBucket)
  const isEmptyList = list.length === 0
  let emptyTitle = ''
  let emptySub = ''
  if (isEmptyList) {
    if (q) {
      emptyTitle = t('没有匹配的历史记录。')
      emptySub = t('换个关键词，或按 Esc 清空搜索。')
    } else if (entries.length === 0) {
      emptyTitle = t('7 天内没有打开过标签的记录。')
      emptySub = t('每次新建标签都会自动留底。')
    } else {
      emptyTitle = t('这个时间段没有标签记录。')
      emptySub = t('每次新建标签都会自动留底。')
    }
  }
  const rows: ReactNode = isEmptyList ? null : list.map(renderRow)

  // 搜索时禁用"清空" —— 避免误把整个桶里没显示的条目也清掉
  const bucketLabel = t(BUCKETS.find((b) => b.key === activeBucket)?.label ?? '')
  const clearCount = grouped[activeBucket].length

  // 仅当 mousedown 与 click 都落在 scrim 自身时关闭（原 bindScrimDismiss：
  // 防止在 modal 里按住选文字拖到外部释放被误判为"点外部"）
  const onScrimDown = (e: ReactMouseEvent): void => {
    downOnScrimRef.current = e.target === e.currentTarget
  }
  const onScrimClick = (e: ReactMouseEvent): void => {
    if (e.target === e.currentTarget && downOnScrimRef.current) closeHistory()
    downOnScrimRef.current = false
  }

  return (
    <div id="historyScrim" className="scrim" hidden={!isOpen} onMouseDown={onScrimDown} onClick={onScrimClick}>
      {isOpen && (
        <div className="modal modal-manage modal-history" role="dialog" aria-modal="true" aria-labelledby="hist-title">
          <div className="mg-head">
            <div>
              <h2 id="hist-title">{t('标签历史')}</h2>
              <p className="sub">{t('最近 7 天内打开过的标签，按最近使用时间排序。')}</p>
            </div>
            <input
              id="hist-search"
              className="mg-search"
              type="search"
              placeholder={t('搜索：分组名 / 路径 / 标签名（支持模糊匹配）')}
              autoComplete="off"
              spellCheck={false}
              ref={searchRef}
              value={searchQuery}
              onChange={(e) => onSearchInput(e.target.value)}
            />
            <button id="hist-close" className="mg-close-btn" type="button" aria-label={t('关闭')} onClick={() => closeHistory()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="hist-layout">
            <nav className="hist-nav" id="hist-nav" aria-label={t('按时间分组')}>
              {/* 计数跟着搜索过滤走，让用户立刻看到哪个时间段有命中 */}
              {BUCKETS.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className={'hist-nav-item' + (b.key === activeBucket ? ' active' : '')}
                  data-bucket={b.key}
                  onClick={() => {
                    if (b.key !== activeBucket) setActiveBucket(b.key)
                  }}
                >
                  <span>{t(b.label)}</span>
                  <span className="count">{filtered(b.key).length}</span>
                </button>
              ))}
            </nav>
            <div className="hist-pane">
              <div className="mg-body" id="hist-body">
                {rows}
              </div>
              <div className="mg-empty" id="hist-empty" hidden={!isEmptyList}>
                <div>{emptyTitle}</div>
                <div className="sub">{emptySub}</div>
              </div>
            </div>
          </div>
          <div className="hist-foot">
            <button
              id="hist-clear"
              className="btn btn-ghost-danger"
              type="button"
              title={q ? t('清空时请先清除搜索词') : ''}
              disabled={clearCount === 0 || !!q}
              onClick={onClear}
            >
              {clearCount > 0 ? t('清空{0}的历史 ({1})', bucketLabel, clearCount) : t('清空{0}的历史', bucketLabel)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
