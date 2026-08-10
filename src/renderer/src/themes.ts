import type { ITheme } from '@xterm/xterm'

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-dark'
export type AppTheme = 'light' | 'dark'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type UsageStyle = 'bar' | 'ring'
export type CloseBehavior = 'quit' | 'tray'
// vertical = 左侧栏分组层级（默认）；horizontal = 隐藏左栏，顶部平铺标签
export type TabBarMode = 'vertical' | 'horizontal'
export type AppLanguage = 'zh' | 'en'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  appTheme: AppTheme
  // model = cc `--model <arg>` 实参（alias 或完整 id）；空串 = 跟随 cc 默认。
  // 只在新建会话（非 --resume）时生效，避免覆盖旧会话原有模型。
  defaults: { cwd: string; autoLaunchCC: boolean; model: string }
  claudePath: string
  npmRegistry: string
  npmMirrorEnabled: boolean    // false = 不用镜像，cc 版本管理走 npm 官方源
  disableAutoupdater: boolean
  lastUsedCwd: string
  sidebarWidth: number
  sidebarCollapsed: boolean
  savedCollapsed: boolean
  sidebarSavedHeight: number   // 「已保存的分组」区像素高度（0 = 用 CSS 默认 40%）
  statusDowngradeSec: number   // done/attention 停留多少秒后降回 idle（1~10）
  showClaudeUsage: boolean     // 底部状态栏展示 Claude 账号用量（5h/周）
  usageStyle: UsageStyle       // 额度显示样式：进度条 / 左右并排圆环
  closeBehavior: CloseBehavior // 点关闭按钮：quit = 确认后退出；tray = 不确认，收进托盘
  showFloater: boolean         // 开启常驻悬浮窗
  floaterX: number | null
  floaterY: number | null
  tabBarMode: TabBarMode       // 标签栏布局：垂直（左栏分组）/ 水平（顶部平铺）
  language: AppLanguage        // 界面语言：zh = 简体中文（默认）；en = English。重启后生效
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
  appTheme: 'light',
  defaults: { cwd: '', autoLaunchCC: false, model: '' },
  claudePath: '',
  npmRegistry: 'https://registry.npmmirror.com',
  npmMirrorEnabled: true,
  disableAutoupdater: true,
  lastUsedCwd: '',
  sidebarWidth: 268,
  sidebarCollapsed: false,
  savedCollapsed: false,
  sidebarSavedHeight: 0,
  statusDowngradeSec: 5,
  showClaudeUsage: true,
  usageStyle: 'bar',
  closeBehavior: 'quit',
  showFloater: false,
  floaterX: null,
  floaterY: null,
  tabBarMode: 'vertical',
  language: 'zh'
}

export const THEMES: Record<ThemePreset, ITheme & { label: string; backgroundCss: string }> = {
  'vscode-dark': {
    label: 'VSCode Dark',
    backgroundCss: '#0a0a0a',
    background: '#0a0a0a',
    foreground: '#e5e5e5',
    cursor: '#e5e5e5',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  },
  'vercel-dark': {
    label: 'Vercel Dark',
    backgroundCss: '#000000',
    background: '#000000',
    foreground: '#ededed',
    cursor: '#ededed',
    cursorAccent: '#000000',
    selectionBackground: '#333333',
    black: '#000000',
    red: '#ff4444',
    green: '#50e3c2',
    yellow: '#f5a623',
    blue: '#0070f3',
    magenta: '#ff0080',
    cyan: '#79ffe1',
    white: '#ededed',
    brightBlack: '#666666',
    brightRed: '#ff6666',
    brightGreen: '#79ffe1',
    brightYellow: '#f7b955',
    brightBlue: '#3b8eea',
    brightMagenta: '#ff66b3',
    brightCyan: '#a9fff0',
    brightWhite: '#ffffff'
  },
  // 不提供浅色终端主题：cc 的 diff/代码块按深色终端假设绘制，浅色下前景落在深底上看不见
  'one-dark': {
    label: 'One Dark',
    backgroundCss: '#282c34',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#d19a66',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  }
}

export function themeForPreset(name: ThemePreset): ITheme {
  const t = THEMES[name] ?? THEMES['vscode-dark']
  // 拆掉 label / backgroundCss，只留 xterm ITheme 字段
  const { label: _l, backgroundCss: _b, ...rest } = t
  void _l; void _b
  return rest
}

export function backgroundFor(name: ThemePreset): string {
  return (THEMES[name] ?? THEMES['vscode-dark']).backgroundCss
}
