import type { ITheme } from '@xterm/xterm'

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-light'
export type CursorStyle = 'block' | 'underline' | 'bar'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  defaults: { cwd: string; autoLaunchCC: boolean }
  claudePath: string
  disableAutoupdater: boolean
  lastUsedCwd: string
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
  lastUsedCwd: ''
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
  'one-light': {
    label: 'One Light',
    backgroundCss: '#fafafa',
    background: '#fafafa',
    foreground: '#383a42',
    cursor: '#383a42',
    cursorAccent: '#fafafa',
    selectionBackground: '#e5e5e6',
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#0184bc',
    magenta: '#a626a4',
    cyan: '#0997b3',
    white: '#fafafa',
    brightBlack: '#a0a1a7',
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
