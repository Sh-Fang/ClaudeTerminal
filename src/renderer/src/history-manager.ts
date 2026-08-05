// 标签历史窗口：仿浏览器历史的左 nav 时间分组 + 右列表 + 底部清空。
// 数据源是主进程 tabHistoryList()（已按 lastSeenAt 倒序）；按"今天 / 昨天 / 更早"
// 切桶，左侧 nav 切换右侧列表。点行/恢复按钮 = 恢复成 live tab；垃圾桶 = 单条删除。

import type { SessionRecord } from './terminal-tab'
import { escapeHtml, formatTs, fuzzySearch, highlightRanges, shortPath, bindScrimDismiss, confirmDialog, type Range } from './ui-helpers'
import { icon } from './svg-icons'
import { t } from './i18n'

export interface HistoryEntry {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  openedAt: string
  lastSeenAt: string
}

export interface HistoryManagerHooks {
  onRestore(entry: HistoryEntry): void
}

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
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'earlier'
  if (t >= todayStartMs) return 'today'
  if (t >= yesterdayStartMs) return 'yesterday'
  return 'earlier'
}

export class HistoryManager {
  private scrim: HTMLDivElement
  private body: HTMLDivElement
  private empty: HTMLDivElement
  private nav: HTMLElement
  private closeBtn: HTMLButtonElement
  private clearBtn: HTMLButtonElement
  private searchInput: HTMLInputElement
  private entries: HistoryEntry[] = []
  private grouped: Record<Bucket, HistoryEntry[]> = { today: [], yesterday: [], earlier: [] }
  private activeBucket: Bucket = 'today'
  private searchQuery = ''

  constructor(private hooks: HistoryManagerHooks) {
    this.scrim = document.getElementById('historyScrim') as HTMLDivElement
    this.body = document.getElementById('hist-body') as HTMLDivElement
    this.empty = document.getElementById('hist-empty') as HTMLDivElement
    this.nav = document.getElementById('hist-nav') as HTMLElement
    this.closeBtn = document.getElementById('hist-close') as HTMLButtonElement
    this.clearBtn = document.getElementById('hist-clear') as HTMLButtonElement
    this.searchInput = document.getElementById('hist-search') as HTMLInputElement
    this.closeBtn.addEventListener('click', () => this.close())
    this.clearBtn.addEventListener('click', () => this.onClear())
    this.nav.addEventListener('click', (e) => this.onNavClick(e))
    bindScrimDismiss(this.scrim, () => this.close())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.scrim.hidden) {
        if (this.searchQuery) {
          this.searchInput.value = ''
          this.searchQuery = ''
          this.applySearchSideEffects()
          this.render()
          return
        }
        this.close()
      }
    })
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value
      this.applySearchSideEffects()
      this.render()
    })
    this.body.addEventListener('click', (e) => this.onBodyClick(e))
  }

  async open(): Promise<void> {
    this.entries = await window.term.tabHistoryList()
    this.regroup()
    this.searchQuery = ''
    this.searchInput.value = ''
    // 打开时默认跳到第一个非空桶（用户最关心今天，但今天为空就跳昨天）
    this.activeBucket = this.firstNonEmptyBucket() ?? 'today'
    this.scrim.hidden = false
    this.render()
  }

  // 输入搜索词后：当前 active 桶被过滤空了就跳到第一个仍有命中的桶，
  // 没有任何命中则保留当前 active（让 empty 提示展示）。
  private applySearchSideEffects(): void {
    if (this.filtered(this.activeBucket).length > 0) return
    for (const b of BUCKETS) {
      if (this.filtered(b.key).length > 0) {
        this.activeBucket = b.key
        return
      }
    }
  }

  close(): void {
    this.scrim.hidden = true
  }

  private async refresh(): Promise<void> {
    this.entries = await window.term.tabHistoryList()
    this.regroup()
    // 当前 active 桶被删空就跳到第一个非空桶；都空就保持原 active（让 empty 提示展示）
    if (this.grouped[this.activeBucket].length === 0) {
      this.activeBucket = this.firstNonEmptyBucket() ?? this.activeBucket
    }
    this.render()
  }

  private regroup(): void {
    const now = new Date()
    const todayStart = startOfDay(now)
    const yesterdayStart = todayStart - 86_400_000
    const buckets: Record<Bucket, HistoryEntry[]> = { today: [], yesterday: [], earlier: [] }
    for (const e of this.entries) buckets[bucketOf(e.lastSeenAt, todayStart, yesterdayStart)].push(e)
    this.grouped = buckets
  }

  private firstNonEmptyBucket(): Bucket | null {
    for (const b of BUCKETS) if (this.grouped[b.key].length > 0) return b.key
    return null
  }

  // 取过滤后的桶列表；空 query 直接返回原桶
  // 命中项 + 每项高亮；有搜索时按匹配分倒序，无搜索时保持原（时间）序。
  // 路径用完整串匹配（保留全路径可搜），只高亮分组名/标签名，路径不高亮。
  private filtered(b: Bucket): Array<{ e: HistoryEntry; hl: Range[][] }> {
    const q = this.searchQuery.trim()
    if (!q) return this.grouped[b].map((e) => ({ e, hl: [] as Range[][] }))
    return this.grouped[b]
      .map((e) => {
        const r = fuzzySearch(q, [e.groupName, e.tabName, e.cwd], [3, 3, 1])
        return r ? { e, hl: r.highlights, score: r.score } : null
      })
      .filter((x): x is { e: HistoryEntry; hl: Range[][]; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
  }

  private render(): void {
    this.renderNav()
    this.renderList()
    this.renderClearBtn()
  }

  private renderClearBtn(): void {
    const bucketLabel = t(BUCKETS.find((b) => b.key === this.activeBucket)?.label ?? '')
    // 搜索时禁用"清空" —— 避免误把整个桶里没显示的条目也清掉
    const q = this.searchQuery.trim()
    const n = this.grouped[this.activeBucket].length
    this.clearBtn.hidden = false
    this.clearBtn.textContent = n > 0 ? t('清空{0}的历史 ({1})', bucketLabel, n) : t('清空{0}的历史', bucketLabel)
    this.clearBtn.disabled = n === 0 || !!q
    this.clearBtn.title = q ? t('清空时请先清除搜索词') : ''
  }

  private renderNav(): void {
    // 计数跟着搜索过滤走，让用户立刻看到哪个时间段有命中
    this.nav.innerHTML = BUCKETS.map((b) => {
      const n = this.filtered(b.key).length
      return `
      <button type="button" class="hist-nav-item${b.key === this.activeBucket ? ' active' : ''}" data-bucket="${b.key}">
        <span>${t(b.label)}</span>
        <span class="count">${n}</span>
      </button>
    `
    }).join('')
  }

  private renderList(): void {
    this.body.innerHTML = ''
    const list = this.filtered(this.activeBucket)
    const isEmpty = list.length === 0
    this.empty.hidden = !isEmpty
    if (isEmpty) {
      const e1 = this.empty.querySelector('div:first-child') as HTMLElement | null
      const sub = this.empty.querySelector('.sub') as HTMLElement | null
      const q = this.searchQuery.trim()
      if (q) {
        if (e1) e1.textContent = t('没有匹配的历史记录。')
        if (sub) sub.textContent = t('换个关键词，或按 Esc 清空搜索。')
      } else if (this.entries.length === 0) {
        if (e1) e1.textContent = t('7 天内没有打开过标签的记录。')
        if (sub) sub.textContent = t('每次新建标签都会自动留底。')
      } else {
        if (e1) e1.textContent = t('这个时间段没有标签记录。')
        if (sub) sub.textContent = t('每次新建标签都会自动留底。')
      }
      return
    }
    for (const { e, hl } of list) this.body.appendChild(this.row(e, hl))
  }

  private row(e: HistoryEntry, hl: Range[][] = []): HTMLDivElement {
    const wrap = document.createElement('div')
    wrap.className = 'mg-row is-visible'
    wrap.dataset.tabId = e.tabId
    const cwd = e.cwd ? escapeHtml(shortPath(e.cwd)) : `<span class="path-placeholder">${t('(默认目录)')}</span>`
    const sessionCount = e.sessions?.length ?? 0
    const sessionMeta = sessionCount > 0 ? t('{0} 个会话', sessionCount) : t('空会话')
    wrap.innerHTML = `
      <div class="mg-head-row">
        <span class="mg-folder">${icon('folder')}</span>
        <div class="mg-info">
          <div class="mg-name">${highlightRanges(e.groupName, hl[0])} <span class="mg-group-name">· ${highlightRanges(e.tabName, hl[1])}</span></div>
          <div class="mg-meta">${cwd} · ${sessionMeta} · ${escapeHtml(formatTs(e.lastSeenAt))}</div>
        </div>
        <button class="mg-btn" data-restore="${escapeHtml(e.tabId)}" title="${t('恢复成新标签')}">${icon('rotate-ccw', { size: 14 })}</button>
        <button class="mg-btn mg-danger" data-delete="${escapeHtml(e.tabId)}" title="${t('从历史里删除此条')}">${icon('trash', { size: 14 })}</button>
      </div>
    `
    return wrap
  }

  private onNavClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('[data-bucket]') as HTMLElement | null
    if (!btn) return
    const b = btn.dataset.bucket as Bucket | undefined
    if (!b || b === this.activeBucket) return
    this.activeBucket = b
    this.render()
  }

  private async onBodyClick(e: MouseEvent): Promise<void> {
    const tgt = e.target as HTMLElement
    const restore = tgt.closest('[data-restore]') as HTMLElement | null
    if (restore) {
      const id = restore.dataset.restore!
      const entry = this.entries.find((x) => x.tabId === id)
      if (entry) {
        // 不关弹窗：后台恢复，用户可能连着恢复多条（与「分组/工作区管理」一致）
        this.hooks.onRestore(entry)
      }
      return
    }
    const del = tgt.closest('[data-delete]') as HTMLElement | null
    if (del) {
      const id = del.dataset.delete!
      const entry = this.entries.find((x) => x.tabId === id)
      if (!entry) return
      confirmDialog({
        title: t('删除这条历史？'),
        message: t('将从历史里删除「<b>{0}</b>」，已打开的标签不受影响。', `${escapeHtml(entry.groupName)} · ${escapeHtml(entry.tabName)}`),
        okLabel: t('删除'),
        onOk: async () => {
          await window.term.tabHistoryDelete(id)
          await this.refresh()
        }
      })
      return
    }
    // 行内任意位置点击（非按钮）= 恢复
    const row = tgt.closest('.mg-row') as HTMLElement | null
    if (row && row.dataset.tabId) {
      const entry = this.entries.find((x) => x.tabId === row.dataset.tabId)
      if (entry) {
        // 不关弹窗：后台恢复，用户可能连着恢复多条（与「分组/工作区管理」一致）
        this.hooks.onRestore(entry)
      }
    }
  }

  private onClear(): void {
    const list = this.grouped[this.activeBucket]
    if (list.length === 0) return
    const bucketLabel = t(BUCKETS.find((b) => b.key === this.activeBucket)?.label ?? '')
    const ids = list.map((e) => e.tabId)
    confirmDialog({
      title: t('清空{0}的历史？', bucketLabel),
      message: t('将清空<b>{0}</b>的 <b>{1}</b> 条历史记录，已打开的标签不受影响。', bucketLabel, ids.length),
      okLabel: t('清空'),
      onOk: async () => {
        await window.term.tabHistoryDeleteMany(ids)
        await this.refresh()
      }
    })
  }
}
