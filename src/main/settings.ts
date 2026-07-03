import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-light'
export type CursorStyle = 'block' | 'underline' | 'bar'

export interface Settings {
  version: 1
  font: {
    family: string
    size: number
    lineHeight: number
  }
  cursor: {
    style: CursorStyle
    blink: boolean
  }
  terminal: {
    scrollback: number
    theme: ThemePreset
  }
  defaults: {
    cwd: string
    autoLaunchCC: boolean
    // model = cc `--model <arg>` 实参：alias（'fable'/'haiku'）或完整 id（'claude-opus-4-8'）；
    // 空串 = 不带 --model，跟随 cc 默认。只在新建会话（非 --resume）时生效。
    model: string
  }
  claudePath: string  // 留空 = 直接调 'claude'；填 = 用这个绝对路径
  disableAutoupdater: boolean  // true = spawn pwsh 时注入 DISABLE_AUTOUPDATER=1
  lastUsedCwd: string  // 最近一次新建分组选择的 cwd，下次预填用
  sidebarWidth: number
  sidebarCollapsed: boolean
  savedCollapsed: boolean  // 「已保存的分组」区是否折叠到底部
  sidebarSavedHeight: number  // 「已保存的分组」区的像素高度（0 = 用 CSS 默认 40%）
  statusDowngradeSec: number   // done/attention 停留多少秒后降回 idle
  confirmCloseUnsaved: boolean // 关闭未保存分组前是否二次确认
  showClaudeUsage: boolean     // 底部状态栏展示 Claude 账号用量（5h/周）
  showFloater: boolean         // 开启常驻悬浮窗（显示待查看 / 待决策 / 运行中 数）
  floaterX: number | null      // 悬浮窗最近一次屏幕位置（null = 未持久化，走默认位）
  floaterY: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  font: {
    family: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    size: 14,
    lineHeight: 1.2
  },
  cursor: { style: 'block', blink: true },
  terminal: { scrollback: 5000, theme: 'vscode-dark' },
  defaults: { cwd: '', autoLaunchCC: false, model: '' },
  claudePath: '',
  disableAutoupdater: true,
  lastUsedCwd: '',
  sidebarWidth: 268,
  sidebarCollapsed: false,
  savedCollapsed: false,
  sidebarSavedHeight: 0,
  statusDowngradeSec: 5,
  confirmCloseUnsaved: true,
  showClaudeUsage: true,
  showFloater: false,
  floaterX: null,
  floaterY: null
}

const FILE = (): string => join(app.getPath('userData'), 'settings.json')

const THEMES: ThemePreset[] = ['vscode-dark', 'vercel-dark', 'one-light']
const CURSORS: CursorStyle[] = ['block', 'underline', 'bar']

function pick<T extends string>(v: unknown, allow: T[], fallback: T): T {
  return typeof v === 'string' && (allow as string[]).includes(v) ? (v as T) : fallback
}
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
// 悬浮窗坐标：null = 未持久化（走默认位）。必须允许负值 —— 副屏在主屏左/上时，
// Windows 虚拟屏坐标 x/y 为负，旧的 [-1,100000] clamp 会把它夹成 -1 丢掉位置。
// 兼容旧版哨兵 -1：历史数据用 -1 表示"未持久化"，归一成 null；真实窗口坐标几乎不可能恰为 -1。
function coord(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === -1) return null
  return Math.min(100000, Math.max(-100000, n))
}

function normalize(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  const font = (r.font as Record<string, unknown>) || {}
  const cursor = (r.cursor as Record<string, unknown>) || {}
  const term = (r.terminal as Record<string, unknown>) || {}
  const def = (r.defaults as Record<string, unknown>) || {}
  return {
    version: 1,
    font: {
      family: typeof font.family === 'string' && font.family.trim() ? font.family : DEFAULT_SETTINGS.font.family,
      size: clampNum(font.size, 8, 40, DEFAULT_SETTINGS.font.size),
      lineHeight: clampNum(font.lineHeight, 1.0, 2.0, DEFAULT_SETTINGS.font.lineHeight)
    },
    cursor: {
      style: pick(cursor.style, CURSORS, DEFAULT_SETTINGS.cursor.style),
      blink: typeof cursor.blink === 'boolean' ? cursor.blink : DEFAULT_SETTINGS.cursor.blink
    },
    terminal: {
      scrollback: clampNum(term.scrollback, 100, 100000, DEFAULT_SETTINGS.terminal.scrollback),
      theme: pick(term.theme, THEMES, DEFAULT_SETTINGS.terminal.theme)
    },
    defaults: {
      cwd: typeof def.cwd === 'string' ? def.cwd : DEFAULT_SETTINGS.defaults.cwd,
      autoLaunchCC: typeof def.autoLaunchCC === 'boolean' ? def.autoLaunchCC : DEFAULT_SETTINGS.defaults.autoLaunchCC,
      // 只收字母数字/-/./_，防止用户手改 settings.json 时把奇怪字符注入到 spawn 命令
      model:
        typeof def.model === 'string' && /^[A-Za-z0-9._-]*$/.test(def.model)
          ? def.model
          : DEFAULT_SETTINGS.defaults.model
    },
    claudePath: typeof r.claudePath === 'string' ? r.claudePath : DEFAULT_SETTINGS.claudePath,
    disableAutoupdater:
      typeof r.disableAutoupdater === 'boolean'
        ? r.disableAutoupdater
        : DEFAULT_SETTINGS.disableAutoupdater,
    lastUsedCwd: typeof r.lastUsedCwd === 'string' ? r.lastUsedCwd : DEFAULT_SETTINGS.lastUsedCwd,
    sidebarWidth: clampNum(r.sidebarWidth, 180, 520, DEFAULT_SETTINGS.sidebarWidth),
    sidebarCollapsed: typeof r.sidebarCollapsed === 'boolean' ? r.sidebarCollapsed : DEFAULT_SETTINGS.sidebarCollapsed,
    savedCollapsed: typeof r.savedCollapsed === 'boolean' ? r.savedCollapsed : DEFAULT_SETTINGS.savedCollapsed,
    sidebarSavedHeight: clampNum(r.sidebarSavedHeight, 0, 4000, DEFAULT_SETTINGS.sidebarSavedHeight),
    statusDowngradeSec: clampNum(r.statusDowngradeSec, 1, 5, DEFAULT_SETTINGS.statusDowngradeSec),
    confirmCloseUnsaved:
      typeof r.confirmCloseUnsaved === 'boolean' ? r.confirmCloseUnsaved : DEFAULT_SETTINGS.confirmCloseUnsaved,
    showClaudeUsage:
      typeof r.showClaudeUsage === 'boolean' ? r.showClaudeUsage : DEFAULT_SETTINGS.showClaudeUsage,
    showFloater:
      typeof r.showFloater === 'boolean' ? r.showFloater : DEFAULT_SETTINGS.showFloater,
    floaterX: coord(r.floaterX),
    floaterY: coord(r.floaterY)
  }
}

export function loadSettings(): Settings {
  try {
    const path = FILE()
    if (!existsSync(path)) return DEFAULT_SETTINGS
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: unknown): Settings {
  const normed = normalize(s)
  const path = FILE()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(normed, null, 2), 'utf8')
  renameSync(tmp, path)
  return normed
}
