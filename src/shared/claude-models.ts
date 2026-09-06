// 模型候选的唯一事实源：内置基础列表 + 运行时「学到」的模型。
// 学习入口：cc statusline 上报当前会话真实模型 —— 用户手动 /model 切成功后，
// 若该模型不在列表里就补进来（如内置只到 opus-4-8，实际切到了 opus-5）。
// main（settings 归一化）与 renderer（两处选择器）共用，避免各写一份判定。

export interface ModelRow {
  label: string
  // 注入 `/model` 与 `--model` 的实参（alias 或完整 id）
  arg: string
  // 用当前模型显示名（小写）子串匹配；alias 行靠它认领同族的完整 id
  match: string
}

export interface LearnedModel {
  // cc 上报的完整模型 id，如 claude-opus-5
  id: string
  // cc 上报的显示名，如 Opus 5；缺失时由 id 推导
  label: string
  learnedAt: string
}

// 内置候选：模型上新/退役时改这里。列表之外的模型由 learnedModels 运行时补齐。
export const BASE_MODEL_GROUPS: { family: string; rows: ModelRow[] }[] = [
  { family: 'Opus', rows: [
    { label: 'Opus 4.8', arg: 'claude-opus-4-8', match: 'opus 4.8' },
    { label: 'Opus 4.7', arg: 'claude-opus-4-7', match: 'opus 4.7' },
    { label: 'Opus 4.6', arg: 'claude-opus-4-6', match: 'opus 4.6' }
  ] },
  { family: 'Sonnet', rows: [
    { label: 'Sonnet 4.6', arg: 'claude-sonnet-4-6', match: 'sonnet 4.6' },
    { label: 'Sonnet 4.5', arg: 'claude-sonnet-4-5', match: 'sonnet 4.5' }
  ] },
  { family: 'Haiku', rows: [
    { label: 'Haiku 4.5', arg: 'haiku', match: 'haiku' }
  ] },
  { family: 'Fable', rows: [
    { label: 'Fable 5', arg: 'fable', match: 'fable' }
  ] }
]

const BASE_ROWS: ModelRow[] = BASE_MODEL_GROUPS.flatMap((g) => g.rows)

// 模型实参最终会拼进 shell 命令，且会落进 settings.json：限定字符集防注入。
// 允许 cc 完整 id 会出现的 `[1m]`（1M 上下文后缀）、`:`、`.`、`@` 等。
const MODEL_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]*$/

export function isSafeModelValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && MODEL_VALUE_RE.test(value)
}

// claude-opus-5 → Opus 5；claude-sonnet-4-6 → Sonnet 4.6；认不出的原样返回。
// 上下文后缀由 withContextSuffix 统一补，避免两条路径各写一份。
export function prettyModelLabel(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

// claude-opus-5 与 claude-opus-5[1m] 是两个不同的选择值，但 cc 上报的 display_name
// 都是「Opus 5」——不把上下文后缀补进显示名，选择器里就是两行一模一样的候选。
export function withContextSuffix(label: string, id: string): string {
  const ctx = /\[(\d+m)\]/i.exec(id)
  if (!ctx) return label
  const suffix = `(${ctx[1].toUpperCase()})`
  return label.includes(suffix) ? label : `${label} ${suffix}`
}

// 是否已被内置行精确覆盖。完整 id、alias、[1m] 变体都是不同选择值，不能按显示名合并。
export function matchBaseRow(id: string): ModelRow | undefined {
  const lowerId = id.toLowerCase()
  return BASE_ROWS.find((r) => r.arg.toLowerCase() === lowerId)
}

// 已知（内置 or 已学到）→ 不必再学；严格按最终注入 /model 的参数判断。
export function isKnownModel(id: string, learned: LearnedModel[]): boolean {
  if (matchBaseRow(id)) return true
  return learned.some((m) => m.id.toLowerCase() === id.toLowerCase())
}

export function normalizeLearnedModels(raw: unknown): LearnedModel[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: LearnedModel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (!isSafeModelValue(r.id)) continue
    const key = r.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const raw = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 64) : prettyModelLabel(r.id)
    // 存量条目也在这里补后缀：早先学到的 [1m] 变体不必等重新学习就能区分
    const label = withContextSuffix(raw, r.id)
    const learnedAt = typeof r.learnedAt === 'string' && r.learnedAt ? r.learnedAt : new Date(0).toISOString()
    out.push({ id: r.id, label, learnedAt })
  }
  // 学到的越新越靠前，选择器里新模型不必翻到底
  return out.sort((a, b) => (a.learnedAt < b.learnedAt ? 1 : a.learnedAt > b.learnedAt ? -1 : 0)).slice(0, 40)
}

export const LEARNED_FAMILY = '已发现'

// 模型下拉的固定高度：内置候选之外还会追加「已发现」，不封顶会长到撑满整屏。
// 设置页与底部状态栏两个选择器共用。
export const MODEL_MENU_MAX_H = 320

// 内置分组 + 「已发现」分组（learnedModels 非空时才追加）
export function modelGroupsWithLearned(
  learned: LearnedModel[]
): { family: string; rows: ModelRow[] }[] {
  if (learned.length === 0) return BASE_MODEL_GROUPS
  return [
    ...BASE_MODEL_GROUPS,
    {
      // 家族名在 UI 侧过 t()：内置的 Opus/Sonnet 等专有名词无词条会原样回退
      family: LEARNED_FAMILY,
      rows: learned.map((m) => ({ label: m.label, arg: m.id, match: m.label.toLowerCase() }))
    }
  ]
}

// 给当前模型打勾：有真实 id 时只做精确匹配；仅旧快照拿不到 id 时才用显示名兜底。
export function isRowActive(row: ModelRow, activeId?: string, activeLabel?: string): boolean {
  if (activeId) return row.arg.toLowerCase() === activeId.toLowerCase()
  const label = (activeLabel ?? '').toLowerCase()
  return !!label && label.includes(row.match)
}
