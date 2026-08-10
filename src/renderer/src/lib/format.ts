// 纯工具函数集（排序/时间/路径/转义/模糊搜索/会话标题等），不做 DOM 渲染。

// 名称自然比较（参照资源管理器）：中文先转拼音再比 —— 否则 zh collator 把 latin 整体排到
// CJK 后面；numeric:true 按数值排；sensitivity:base 大小写不敏感。
import { pinyin } from 'pinyin-pro'
import { t } from '../i18n'
import type { SessionRecord } from '../terminal-tab'

const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
function nameSortKey(s: string): string {
  // 去声调拼音串 + 原串作 tiebreak 后缀
  const py = pinyin(s, { toneType: 'none', type: 'string', nonZh: 'consecutive' })
  return `${py.toLowerCase()}|${s.toLowerCase()}`
}
export function naturalNameCompare(a: string, b: string): number {
  return NAME_COLLATOR.compare(nameSortKey(a), nameSortKey(b))
}

// ISO 时间串「新→旧」比较（字典序即时序）
export function recencyDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

// 拼音首字母（a-z），非字母归 '#'；与 naturalNameCompare 同一套转换，保证跳转条与排序一致
export function nameInitial(s: string): string {
  const py = pinyin(s.trim(), { toneType: 'none', type: 'string', nonZh: 'consecutive' })
  const ch = py.trim().charAt(0).toLowerCase()
  return /[a-z]/.test(ch) ? ch : '#'
}

// 仅当 mousedown 与 click 都落在 scrim 自身才关闭：防 modal 内选字拖到外部释放被误判"点外部"
export function bindScrimDismiss(scrim: HTMLElement, onDismiss: () => void): void {
  let downOnScrim = false
  scrim.addEventListener('mousedown', (e) => {
    downOnScrim = e.target === scrim
  })
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim && downOnScrim) onDismiss()
    downOnScrim = false
  })
}

// 模糊搜索：空格分词(AND) + 连续子串优先/子序列次之 + 中文按拼音建索引（"lkgd" 命中「理科工单」），
// 返回分数与各字段高亮区间，不命中返回 null。
export type Range = [number, number] // [start, end) 原始字符下标

const SEP_RE = /[\s\-_/\\.,:：·|]/
const CJK_RE = /[一-鿿]/

// 字段检索索引：raw = 小写原串；pyFlat = 拼音展开串（无中文时置空），pyMap 映射回原下标
interface Hay {
  raw: string
  pyFlat: string
  pyMap: number[]
}
const hayCache = new Map<string, Hay>()
function buildHay(text: string): Hay {
  const cached = hayCache.get(text)
  if (cached) return cached
  let pyFlat = ''
  const pyMap: number[] = []
  let hasCJK = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (CJK_RE.test(ch)) {
      hasCJK = true
      const py = pinyin(ch, { toneType: 'none', type: 'string', nonZh: 'removed' }).toLowerCase() || ch.toLowerCase()
      for (const c of py) { pyFlat += c; pyMap.push(i) }
    } else {
      pyFlat += ch.toLowerCase()
      pyMap.push(i)
    }
  }
  const hay: Hay = { raw: text.toLowerCase(), pyFlat: hasCJK ? pyFlat : '', pyMap }
  if (hayCache.size > 2000) hayCache.clear() // 封顶防无限增长
  hayCache.set(text, hay)
  return hay
}

function isBoundary(flat: string, pos: number): boolean {
  return pos === 0 || SEP_RE.test(flat[pos - 1])
}

// 单个词在一条 flat 串里的最佳命中
function matchInFlat(term: string, flat: string): { score: number; positions: number[] } | null {
  if (!term) return { score: 0, positions: [] }
  // 1) 连续子串：词首加权 + 越靠前越好
  let best: { score: number; positions: number[] } | null = null
  for (let idx = flat.indexOf(term); idx >= 0; idx = flat.indexOf(term, idx + 1)) {
    let score = 1000 + (isBoundary(flat, idx) ? 200 : 0) - idx
    if (idx === 0 && term.length === flat.length) score += 500 // 整字段精确命中
    if (!best || score > best.score) {
      best = { score, positions: Array.from({ length: term.length }, (_, k) => idx + k) }
    }
  }
  if (best) return best
  // 2) 子序列：字符按序出现即可，分数低
  const positions: number[] = []
  let i = 0
  for (let k = 0; k < flat.length && i < term.length; k++) {
    if (flat.charCodeAt(k) === term.charCodeAt(i)) { positions.push(k); i++ }
  }
  if (i < term.length) return null
  const gaps = positions[positions.length - 1] - positions[0] - (term.length - 1)
  const score = 400 + (isBoundary(flat, positions[0]) ? 100 : 0) - gaps * 8 - positions[0]
  return { score, positions }
}

function toRanges(indices: number[]): Range[] {
  const uniq = [...new Set(indices)].sort((a, b) => a - b)
  const ranges: Range[] = []
  for (const idx of uniq) {
    const last = ranges[ranges.length - 1]
    if (last && idx === last[1]) last[1] = idx + 1
    else ranges.push([idx, idx + 1])
  }
  return ranges
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

// 一个词命中一个字段：raw 与拼音两条索引取高分，命中位置回映成原字符区间
function matchTermInField(term: string, hay: Hay): { score: number; ranges: Range[] } | null {
  const rawM = matchInFlat(term, hay.raw)
  let best = rawM ? { score: rawM.score, positions: rawM.positions, map: null as number[] | null } : null
  if (hay.pyFlat) {
    const pyM = matchInFlat(term, hay.pyFlat)
    // 拼音命中略降权，优先直接命中
    if (pyM && (!best || pyM.score - 50 > best.score)) {
      best = { score: pyM.score - 50, positions: pyM.positions, map: hay.pyMap }
    }
  }
  if (!best) return null
  const orig = best.map ? best.positions.map((p) => best!.map![p]) : best.positions
  return { score: best.score, ranges: toRanges(orig) }
}

export interface FuzzyResult {
  score: number
  highlights: Range[][] // 与 fields 等长，每项是该字段的高亮区间
}

// 所有词都命中（任一字段）才算整体命中；weights 给字段加权；空 query → 命中且 score=0
export function fuzzySearch(query: string, fields: string[], weights?: number[]): FuzzyResult | null {
  const highlights: Range[][] = fields.map(() => [])
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { score: 0, highlights }
  const hays = fields.map(buildHay)
  let total = 0
  for (const term of terms) {
    let bestIdx = -1
    let bestScore = -Infinity
    let bestRanges: Range[] = []
    for (let fi = 0; fi < fields.length; fi++) {
      if (!fields[fi]) continue
      const m = matchTermInField(term, hays[fi])
      if (!m) continue
      const s = m.score * (weights?.[fi] ?? 1)
      if (s > bestScore) { bestScore = s; bestIdx = fi; bestRanges = m.ranges }
    }
    if (bestIdx < 0) return null // 有词未命中任何字段 → 整体失败
    total += bestScore
    highlights[bestIdx] = mergeRanges([...highlights[bestIdx], ...bestRanges])
  }
  return { score: total, highlights }
}

// 兼容旧调用：不要分数/高亮的布尔判断
export function fuzzyMatch(needle: string, haystacks: string | string[]): boolean {
  const list = Array.isArray(haystacks) ? haystacks : [haystacks]
  return fuzzySearch(needle, list) !== null
}

// 按区间把 text 包上 <mark class="hl">，其余转义
export function highlightRanges(text: string, ranges?: Range[]): string {
  if (!ranges || ranges.length === 0) return escapeHtml(text)
  const sorted = mergeRanges(ranges)
  let out = ''
  let pos = 0
  for (const [s, e] of sorted) {
    if (s > pos) out += escapeHtml(text.slice(pos, s))
    out += `<mark class="hl">${escapeHtml(text.slice(s, e))}</mark>`
    pos = e
  }
  if (pos < text.length) out += escapeHtml(text.slice(pos))
  return out
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  )
}

export function shortPath(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.length <= 2) return p
  return '…\\' + segs.slice(-2).join('\\')
}

export function formatTs(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  const isYest = d.toDateString() === yest.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return t('今天 {0}:{1}', hh, mm)
  if (isYest) return t('昨天 {0}:{1}', hh, mm)
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

export function srcLabel(s: string): string {
  // resume 用 '恢复||来源' 消歧：'恢复' 已被按钮（Restore）占用，此处应译 Resumed
  const v = ({ clear: '/clear 后', startup: '初始', compact: 'compact', resume: '恢复||来源' } as Record<string, string>)[s]
  return v ? t(v) : s
}

export function statusLabel(s?: string): string {
  const v = ({ busy: '运行中', attention: '需要你决策', done: '完成，待查看', idle: '空闲', error: '出错' } as Record<string, string>)[
    s || 'idle'
  ]
  return t(v || '空闲')
}
export function statusShort(s?: string): string {
  const v = ({ busy: '运行中', attention: '待决策', done: '待查看', error: '错误' } as Record<string, string>)[s || 'idle']
  return v ? t(v) : ''
}

// 会话默认名「会话 N」：N 按 createdAt 排序算，不用栈位置（resume 会把旧条目挪到栈顶，
// 用栈位置「会话 1」会跟着移动，反直觉）。
export function defaultSessionTitle(sess: SessionRecord, sessions: SessionRecord[]): string {
  const sorted = [...sessions].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  const idx = sorted.findIndex((s) => s.sessionId === sess.sessionId)
  return t('会话 {0}', idx >= 0 ? idx + 1 : sessions.length)
}

export function sessionTitle(sess: SessionRecord, sessions: SessionRecord[]): string {
  return sess.userTitle || defaultSessionTitle(sess, sessions)
}
