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
  }
  claudePath: string  // 留空 = 直接调 'claude'；填 = 用这个绝对路径
  disableAutoupdater: boolean  // true = spawn pwsh 时注入 DISABLE_AUTOUPDATER=1
  lastUsedCwd: string  // 最近一次新建分组选择的 cwd，下次预填用
  sidebarWidth: number
  sidebarCollapsed: boolean
  savedCollapsed: boolean  // 「已保存的分组」区是否折叠到底部
  savedSidebarLimit: number    // 侧边栏「已保存的分组」最多显示几个
  statusDowngradeSec: number   // done/attention 停留多少秒后降回 idle
  confirmCloseUnsaved: boolean // 关闭未保存分组前是否二次确认
  showClaudeUsage: boolean     // 底部状态栏展示 Claude 账号用量（5h/周）
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
  defaults: { cwd: '', autoLaunchCC: true },
  claudePath: '',
  disableAutoupdater: true,
  lastUsedCwd: '',
  sidebarWidth: 268,
  sidebarCollapsed: false,
  savedCollapsed: false,
  savedSidebarLimit: 4,
  statusDowngradeSec: 5,
  confirmCloseUnsaved: true,
  showClaudeUsage: false
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
      autoLaunchCC: typeof def.autoLaunchCC === 'boolean' ? def.autoLaunchCC : DEFAULT_SETTINGS.defaults.autoLaunchCC
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
    savedSidebarLimit: clampNum(r.savedSidebarLimit, 0, 5, DEFAULT_SETTINGS.savedSidebarLimit),
    statusDowngradeSec: clampNum(r.statusDowngradeSec, 1, 5, DEFAULT_SETTINGS.statusDowngradeSec),
    confirmCloseUnsaved:
      typeof r.confirmCloseUnsaved === 'boolean' ? r.confirmCloseUnsaved : DEFAULT_SETTINGS.confirmCloseUnsaved,
    showClaudeUsage:
      typeof r.showClaudeUsage === 'boolean' ? r.showClaudeUsage : DEFAULT_SETTINGS.showClaudeUsage
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
