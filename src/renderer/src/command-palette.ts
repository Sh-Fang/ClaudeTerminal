// 顶栏命令面板：搜索"打开的 tab / 已保存分组 / 7 天标签历史",Enter 主动作,Ctrl+Enter 次动作。
// 打分见 scoreMatch —— 前缀/子串/fuzzy 三档 + 类型权重 + 字段权重 + 长度惩罚。
import type { HistoryEntry } from './history-manager'
import { escapeHtml, shortPath, formatTs } from './ui-helpers'

export type CmdKind = 'tab' | 'saved' | 'history'

// 一条命中的展示 + 路由信息。route 层面只留 id 与关键字段,由 hooks 消费。
export interface CmdItem {
  kind: CmdKind
  id: string          // tabId / savedId / historyTabId
  title: string       // 主展示名(未高亮)
  sub: string         // 副信息(未高亮,通常是 cwd)
  badge?: string      // 右侧小字(时间/tab 数等)
  score: number
  // 高亮的段: [start, end) 半开区间,以 <title>+' '+<sub> 拼接后的下标表示
  hits: Array<[number, number]>
  hitsInTitle: Array<[number, number]>
  hitsInSub: Array<[number, number]>
}

export interface CmdOpenTabCandidate {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  lastActive: number // 用于同分排序 & 最近使用空态
}

export interface CmdSavedCandidate {
  savedId: string
  name: string
  cwd: string
  tabCount: number
  savedAt: string
}

export interface CommandPaletteHooks {
  getOpenTabs(): CmdOpenTabCandidate[]
  getSaved(): CmdSavedCandidate[]
  getHistory(): Promise<HistoryEntry[]>
  // Enter 主动作
  activateTab(tabId: string): void
  restoreSavedPick(savedId: string): void
  restoreFromHistory(tabId: string): void
  // Ctrl+Enter 次动作
  copyPathToClipboard(path: string): void
  restoreSavedAll(savedId: string): void
  // Esc / 命中后需要把焦点还给终端
  focusActiveTerminal(): void
}

// ─── 打分:前缀/子串/连续 fuzzy 三档 ─────────────────────────────────
// 需要 : 匹配段的 [start, end) 半开区间列表(合并后)
interface ScoreResult {
  score: number
  hits: Array<[number, number]>
}

// 单字段打分(小写化后再算,大小写不敏感)。空 needle 返回 0 分,不算命中。
function scoreField(needle: string, hay: string): ScoreResult {
  if (!needle) return { score: 0, hits: [] }
  const n = needle.toLowerCase()
  const h = hay.toLowerCase()

  // 前缀完全匹配
  if (h.startsWith(n)) {
    return { score: 100 + Math.max(0, 20 - hay.length) * 0.5, hits: [[0, n.length]] }
  }

  // 单词前缀:非字母数字后紧跟 needle(空格/-/_/.、路径分隔符等)
  const wp = new RegExp(`(?:^|[^a-z0-9])(${escapeReg(n)})`, 'i').exec(hay)
  if (wp && typeof wp.index === 'number') {
    const start = wp.index + wp[0].length - n.length
    return { score: 70 - Math.min(30, start), hits: [[start, start + n.length]] }
  }

  // 子串命中
  const sub = h.indexOf(n)
  if (sub >= 0) {
    return { score: 45 - Math.min(30, sub), hits: [[sub, sub + n.length]] }
  }

  // 连续 fuzzy:needle 字符按顺序在 hay 中出现,记录每字符位置。
  // 每字符基础 4 分,相邻(gap=1)不扣、gap 越大扣得越多;整体不超过 40。
  const hits: Array<[number, number]> = []
  let hi = 0
  let last = -1
  let gaps = 0
  for (const c of n) {
    const found = h.indexOf(c, hi)
    if (found < 0) return { score: 0, hits: [] }
    if (last >= 0) gaps += found - last - 1
    hits.push([found, found + 1])
    last = found
    hi = found + 1
  }
  const raw = n.length * 4 - Math.min(30, gaps)
  if (raw <= 0) return { score: 0, hits: [] }
  return { score: Math.min(40, raw), hits: mergeAdjacent(hits) }
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 相邻半开区间合并(端点相等即合并):[[3,4],[4,5]] → [[3,5]]
function mergeAdjacent(hits: Array<[number, number]>): Array<[number, number]> {
  if (hits.length <= 1) return hits
  const out: Array<[number, number]> = [hits[0].slice() as [number, number]]
  for (let i = 1; i < hits.length; i++) {
    const [s, e] = hits[i]
    const cur = out[out.length - 1]
    if (s <= cur[1]) cur[1] = Math.max(cur[1], e)
    else out.push([s, e])
  }
  return out
}

// 多字段打分:取最大 score;权重 = 字段权重 × 类型权重 ÷ sqrt(name 长度)。
// hits 只保留命中主字段(title 或 sub)的区间,便于渲染高亮。
export function scoreItem(
  needle: string,
  fields: { title: string; sub: string; extras?: string[] },
  typeWeight: number
): { score: number; hitsInTitle: Array<[number, number]>; hitsInSub: Array<[number, number]> } {
  if (!needle) return { score: 0, hitsInTitle: [], hitsInSub: [] }
  const t = scoreField(needle, fields.title)
  const s = scoreField(needle, fields.sub)
  let best = { score: t.score, from: 'title' as 'title' | 'sub' | 'extra', hits: t.hits }
  if (s.score * 0.55 > best.score) best = { score: s.score * 0.55, from: 'sub', hits: s.hits }
  for (const e of fields.extras ?? []) {
    const r = scoreField(needle, e)
    // extras 主要是 groupName,权重比 sub 略高一点
    if (r.score * 0.7 > best.score) best = { score: r.score * 0.7, from: 'extra', hits: [] }
  }
  if (best.score <= 0) return { score: 0, hitsInTitle: [], hitsInSub: [] }
  const lenPenalty = Math.sqrt(Math.max(1, fields.title.length / 8))
  const finalScore = (best.score * typeWeight) / lenPenalty
  return {
    score: finalScore,
    hitsInTitle: best.from === 'title' ? best.hits : [],
    hitsInSub: best.from === 'sub' ? best.hits : []
  }
}

// 高亮渲染:把 hits 半开区间套 <mark>,其余 escape。空 hits 即整体 escape。
export function renderHighlight(text: string, hits: Array<[number, number]>): string {
  if (!hits.length) return escapeHtml(text)
  const parts: string[] = []
  let cur = 0
  for (const [s, e] of hits) {
    if (s > cur) parts.push(escapeHtml(text.slice(cur, s)))
    parts.push(`<mark>${escapeHtml(text.slice(s, e))}</mark>`)
    cur = e
  }
  if (cur < text.length) parts.push(escapeHtml(text.slice(cur)))
  return parts.join('')
}

// ─── 候选整合 + 排序 ─────────────────────────────────────────────
const TYPE_WEIGHT: Record<CmdKind, number> = { tab: 1.0, saved: 0.9, history: 0.7 }
const MAX_RESULTS = 20

interface Ranked {
  item: CmdItem
  raw: { kind: CmdKind; id: string; extra?: unknown }
}

function rankOpenTab(needle: string, c: CmdOpenTabCandidate): Ranked | null {
  const r = scoreItem(needle, { title: c.tabName, sub: c.cwd, extras: [c.groupName] }, TYPE_WEIGHT.tab)
  if (r.score <= 0) return null
  return {
    item: {
      kind: 'tab', id: c.tabId,
      title: c.tabName, sub: `${c.groupName} · ${shortPath(c.cwd)}`,
      score: r.score, hits: [], hitsInTitle: r.hitsInTitle, hitsInSub: r.hitsInSub
    },
    raw: { kind: 'tab', id: c.tabId }
  }
}

function rankSaved(needle: string, c: CmdSavedCandidate): Ranked | null {
  const r = scoreItem(needle, { title: c.name, sub: c.cwd }, TYPE_WEIGHT.saved)
  if (r.score <= 0) return null
  return {
    item: {
      kind: 'saved', id: c.savedId,
      title: c.name, sub: `${c.tabCount} 个标签 · ${shortPath(c.cwd)}`,
      badge: formatTs(c.savedAt),
      score: r.score, hits: [], hitsInTitle: r.hitsInTitle, hitsInSub: r.hitsInSub
    },
    raw: { kind: 'saved', id: c.savedId }
  }
}

function rankHistory(needle: string, h: HistoryEntry): Ranked | null {
  const r = scoreItem(needle, { title: h.tabName, sub: h.cwd, extras: [h.groupName] }, TYPE_WEIGHT.history)
  if (r.score <= 0) return null
  return {
    item: {
      kind: 'history', id: h.tabId,
      title: h.tabName, sub: `${h.groupName} · ${shortPath(h.cwd)}`,
      badge: formatTs(h.lastSeenAt),
      score: r.score, hits: [], hitsInTitle: r.hitsInTitle, hitsInSub: r.hitsInSub
    },
    raw: { kind: 'history', id: h.tabId }
  }
}

export function rankCandidates(
  needle: string,
  open: CmdOpenTabCandidate[],
  saved: CmdSavedCandidate[],
  history: HistoryEntry[]
): CmdItem[] {
  const q = needle.trim()
  if (!q) return []
  const out: Ranked[] = []
  for (const t of open) { const r = rankOpenTab(q, t); if (r) out.push(r) }
  for (const s of saved) { const r = rankSaved(q, s); if (r) out.push(r) }
  // 历史去重:与已展示的 open tab 同 id 则跳过(避免同一个 tab 被列两次)
  const openIds = new Set(open.map((t) => t.tabId))
  for (const h of history) {
    if (openIds.has(h.tabId)) continue
    const r = rankHistory(q, h); if (r) out.push(r)
  }
  out.sort((a, b) => b.item.score - a.item.score)
  return out.slice(0, MAX_RESULTS).map((r) => r.item)
}

// ─── 空态:最近使用 (open tabs by lastActive desc + 最近 saved) ───────
export function emptyStateItems(
  open: CmdOpenTabCandidate[],
  saved: CmdSavedCandidate[]
): CmdItem[] {
  const items: CmdItem[] = []
  const sortedOpen = [...open].sort((a, b) => b.lastActive - a.lastActive).slice(0, 3)
  for (const t of sortedOpen) {
    items.push({
      kind: 'tab', id: t.tabId,
      title: t.tabName, sub: `${t.groupName} · ${shortPath(t.cwd)}`,
      score: 0, hits: [], hitsInTitle: [], hitsInSub: []
    })
  }
  const sortedSaved = [...saved].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')).slice(0, 2)
  for (const s of sortedSaved) {
    items.push({
      kind: 'saved', id: s.savedId,
      title: s.name, sub: `${s.tabCount} 个标签 · ${shortPath(s.cwd)}`,
      badge: formatTs(s.savedAt),
      score: 0, hits: [], hitsInTitle: [], hitsInSub: []
    })
  }
  return items
}

// ─── 面板控制器 ────────────────────────────────────────────────
export class CommandPalette {
  private searchEl = document.getElementById('cmdpalSearch') as HTMLDivElement
  private inputEl = document.getElementById('cmdpalInput') as HTMLInputElement
  private panelEl = document.getElementById('cmdpalPanel') as HTMLDivElement
  private items: CmdItem[] = []
  private activeIdx = 0
  private historyCache: HistoryEntry[] = []
  private historyLoadedAt = 0

  constructor(private hooks: CommandPaletteHooks) {
    this.inputEl.addEventListener('input', () => void this.refresh())
    this.inputEl.addEventListener('focus', () => {
      this.searchEl.classList.add('focus')
      void this.refresh()
    })
    this.inputEl.addEventListener('blur', () => {
      // 延迟关闭,让面板 click 事件能先跑
      setTimeout(() => {
        if (document.activeElement !== this.inputEl) {
          this.searchEl.classList.remove('focus')
          this.close()
        }
      }, 120)
    })
    this.inputEl.addEventListener('keydown', (e) => this.onKey(e))
    this.panelEl.addEventListener('mousedown', (e) => {
      // 阻止 blur 抢先关闭
      e.preventDefault()
    })
    this.panelEl.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-idx]') as HTMLElement | null
      if (!row) return
      const idx = Number(row.dataset.idx)
      if (Number.isFinite(idx)) this.commit(idx, e.ctrlKey || e.metaKey)
    })
    // 全局 Ctrl+P 打开
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        this.open()
      }
    }, true)
  }

  open(): void {
    this.inputEl.focus()
    this.inputEl.select()
  }

  close(): void {
    this.panelEl.hidden = true
    this.items = []
    this.activeIdx = 0
  }

  clearInput(): void {
    this.inputEl.value = ''
  }

  private async ensureHistory(): Promise<HistoryEntry[]> {
    // 打开面板后 5s 内复用缓存;避免每次输入都跨进程拿一遍
    const now = performance.now()
    if (now - this.historyLoadedAt < 5000 && this.historyCache.length) return this.historyCache
    try {
      this.historyCache = await this.hooks.getHistory()
      this.historyLoadedAt = now
    } catch { this.historyCache = [] }
    return this.historyCache
  }

  private async refresh(): Promise<void> {
    const q = this.inputEl.value
    const open = this.hooks.getOpenTabs()
    const saved = this.hooks.getSaved()
    if (!q.trim()) {
      this.items = emptyStateItems(open, saved)
    } else {
      const history = await this.ensureHistory()
      this.items = rankCandidates(q, open, saved, history)
    }
    this.activeIdx = 0
    this.render(q)
  }

  private render(q: string): void {
    if (this.items.length === 0) {
      this.panelEl.hidden = false
      this.panelEl.innerHTML = q.trim()
        ? `<div class="cmdpal-empty">没有匹配的标签、分组或历史。</div>`
        : `<div class="cmdpal-empty">开始输入以搜索标签、分组、路径…</div>`
      return
    }
    const label = q.trim() ? '搜索结果' : '最近使用'
    const kindText: Record<CmdKind, string> = { tab: 'TAB', saved: 'SAVED', history: 'HIST' }
    const rows = this.items.map((it, idx) => {
      const active = idx === this.activeIdx ? ' active' : ''
      const badge = it.badge ? `<span class="ci-badge">${escapeHtml(it.badge)}</span>` : ''
      const title = renderHighlight(it.title, it.hitsInTitle)
      const sub = renderHighlight(it.sub, it.hitsInSub)
      return `
        <div class="cmdpal-item${active}" data-idx="${idx}" role="option" aria-selected="${idx === this.activeIdx}">
          <span class="ci-kind">${kindText[it.kind]}</span>
          <div class="ci-body">
            <div class="ci-title">${title}</div>
            <div class="ci-sub">${sub}</div>
          </div>
          ${badge}
        </div>`
    }).join('')
    this.panelEl.hidden = false
    this.panelEl.innerHTML = `
      <div class="cmdpal-section-label">${escapeHtml(label)}</div>
      ${rows}
      <div class="cmdpal-foot">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>Ctrl+Enter</kbd> 次动作</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>`
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.inputEl.blur()
      this.close()
      this.hooks.focusActiveTerminal()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (this.items.length === 0) return
      this.activeIdx = (this.activeIdx + 1) % this.items.length
      this.renderActive()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (this.items.length === 0) return
      this.activeIdx = (this.activeIdx - 1 + this.items.length) % this.items.length
      this.renderActive()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (this.items.length === 0) return
      this.commit(this.activeIdx, e.ctrlKey || e.metaKey)
      return
    }
  }

  // 只更新 active class,不重渲整个 list
  private renderActive(): void {
    const rows = this.panelEl.querySelectorAll<HTMLElement>('.cmdpal-item')
    rows.forEach((el, i) => {
      const on = i === this.activeIdx
      el.classList.toggle('active', on)
      el.setAttribute('aria-selected', on ? 'true' : 'false')
      if (on) el.scrollIntoView({ block: 'nearest' })
    })
  }

  private commit(idx: number, secondary: boolean): void {
    const it = this.items[idx]
    if (!it) return
    this.close()
    this.inputEl.value = ''
    this.inputEl.blur()
    this.searchEl.classList.remove('focus')
    if (secondary) this.dispatchSecondary(it)
    else this.dispatchPrimary(it)
    this.hooks.focusActiveTerminal()
  }

  private dispatchPrimary(it: CmdItem): void {
    if (it.kind === 'tab') this.hooks.activateTab(it.id)
    else if (it.kind === 'saved') this.hooks.restoreSavedPick(it.id)
    else if (it.kind === 'history') this.hooks.restoreFromHistory(it.id)
  }

  private dispatchSecondary(it: CmdItem): void {
    if (it.kind === 'tab') {
      // 用 sub 里的 cwd 部分需要额外传;这里直接从 items 找不到 cwd,回退到主动作
      // 由 hooks 侧从 tabId 反查 cwd 更稳,这里传 tabId 让 hooks 自己拿
      this.hooks.copyPathToClipboard(it.id)
    } else if (it.kind === 'saved') {
      this.hooks.restoreSavedAll(it.id)
    } else if (it.kind === 'history') {
      // history 次动作同主动作,避免误操作
      this.hooks.restoreFromHistory(it.id)
    }
  }
}
