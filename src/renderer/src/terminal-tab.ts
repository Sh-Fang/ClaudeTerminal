import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { backgroundFor, themeForPreset, type Settings } from './themes'

export interface TermTabHandlers {
  copySelectionAsAnswer: () => boolean
  openSearch: () => void
  onRequestNewTab: () => void
  onRequestCloseSelf: () => void
  onPtyStarted?: () => void
}

export interface SessionRecord {
  sessionId: string
  source: 'startup' | 'clear' | 'compact' | 'resume'
  createdAt: string
  aiTitle?: string
  lastTs?: string
}

export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

export class TerminalTab {
  readonly id: string
  name: string
  cwd: string
  sessions: SessionRecord[]
  activeSessionId: string | undefined
  autoLaunchCC: boolean
  status: TabStatus
  note?: string

  readonly host: HTMLDivElement
  readonly term: Terminal
  readonly fit: FitAddon
  readonly search: SearchAddon

  ptyId: number | null = null
  private pendingInput = ''
  private waitingForRestart = false
  private webgl: WebglAddon | null = null
  private disposed = false
  private handlers: TermTabHandlers

  constructor(
    opts: {
      id: string
      name: string
      cwd: string
      sessions?: SessionRecord[]
      activeSessionId?: string
      autoLaunchCC?: boolean
      status?: TabStatus
      note?: string
      settings: Settings
    },
    handlers: TermTabHandlers
  ) {
    this.id = opts.id
    this.name = opts.name
    this.cwd = opts.cwd
    this.sessions = opts.sessions ?? []
    this.activeSessionId = opts.activeSessionId
    this.autoLaunchCC = opts.autoLaunchCC !== false
    this.status = opts.status ?? 'idle'
    this.note = opts.note
    this.handlers = handlers

    this.host = document.createElement('div')
    this.host.className = 'term-host'
    this.host.dataset.tabId = this.id
    this.host.style.background = backgroundFor(opts.settings.terminal.theme)

    this.term = new Terminal({
      fontFamily: opts.settings.font.family,
      fontSize: opts.settings.font.size,
      lineHeight: opts.settings.font.lineHeight,
      cursorBlink: opts.settings.cursor.blink,
      cursorStyle: opts.settings.cursor.style,
      scrollback: opts.settings.terminal.scrollback,
      allowProposedApi: true,
      theme: themeForPreset(opts.settings.terminal.theme),
      windowsPty: { backend: 'conpty' }
    })

    this.fit = new FitAddon()
    this.search = new SearchAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        void window.term.openExternal(uri)
      })
    )

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
        handlers.onRequestNewTab()
        return false
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
        handlers.onRequestCloseSelf()
        return false
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        const sel = this.term.getSelection()
        if (sel) {
          void navigator.clipboard.writeText(sel)
          this.term.clearSelection()
          return false
        }
        return true
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = this.term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel)
        return false
      }
      // Ctrl+V 由 xterm 内置 paste handler 处理（不要手动 send，否则会重复）

      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        handlers.openSearch()
        return false
      }

      return true
    })

    this.term.onData((d) => {
      if (this.waitingForRestart) {
        this.waitingForRestart = false
        void this.startPty()
        return
      }
      if (this.ptyId == null) {
        this.pendingInput += d
        return
      }
      window.term.send(this.ptyId, d)
    })
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.host)
    this.term.open(this.host)
    try { this.fit.fit() } catch {}
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        try { webgl.dispose() } catch {}
      })
      this.term.loadAddon(webgl)
      this.webgl = webgl
    } catch (e) {
      console.warn('[term] WebGL renderer unavailable:', e)
    }
  }

  async startPty(): Promise<void> {
    if (this.disposed) return
    try {
      const id = await window.term.create({
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.cwd,
        tabId: this.id
      })
      this.ptyId = id
      if (this.pendingInput) {
        window.term.send(id, this.pendingInput)
        this.pendingInput = ''
      }
      this.handlers.onPtyStarted?.()
    } catch (e) {
      const msg = (e as Error)?.message || String(e)
      this.status = 'error'
      this.note = msg
      this.term.writeln('')
      this.term.writeln(`\x1b[31m[启动 shell 失败] ${msg}\x1b[0m`)
      this.term.writeln('\x1b[90m请检查分组的路径是否仍存在，按任意键重试。\x1b[0m')
      this.waitingForRestart = true
    }
  }

  writeFromPty(data: string): void {
    this.term.write(data)
  }

  handlePtyExit(exitCode: number): void {
    this.ptyId = null
    this.term.writeln('')
    this.term.writeln(`\x1b[90m[pwsh 已退出 · 退出码 ${exitCode}]\x1b[0m`)
    this.term.writeln('\x1b[90m按任意键重启 shell…\x1b[0m')
    this.waitingForRestart = true
  }

  // 切换会话：kill 当前 PTY、清屏、重新 spawn（启动后 launchCC 会按新 activeSessionId 走 resume）
  async restartPty(): Promise<void> {
    if (this.disposed) return
    if (this.ptyId != null) {
      window.term.kill(this.ptyId)
      this.ptyId = null
    }
    this.term.reset()
    this.waitingForRestart = false
    await this.startPty()
  }

  refit(): void {
    try { this.fit.fit() } catch {}
    if (this.ptyId != null) window.term.resize(this.ptyId, this.term.cols, this.term.rows)
  }

  applySettings(s: Settings): void {
    const opts = this.term.options
    opts.fontFamily = s.font.family
    opts.fontSize = s.font.size
    opts.lineHeight = s.font.lineHeight
    opts.cursorBlink = s.cursor.blink
    opts.cursorStyle = s.cursor.style
    opts.scrollback = s.terminal.scrollback
    opts.theme = themeForPreset(s.terminal.theme)
    this.host.style.background = backgroundFor(s.terminal.theme)
    try { this.fit.fit() } catch {}
    if (this.ptyId != null) window.term.resize(this.ptyId, this.term.cols, this.term.rows)
  }

  setActive(active: boolean): void {
    this.host.classList.toggle('active', active)
    if (active) {
      this.refit()
      setTimeout(() => this.term.focus(), 0)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.ptyId != null) {
      window.term.kill(this.ptyId)
      this.ptyId = null
    }
    try { this.webgl?.dispose() } catch {}
    try { this.term.dispose() } catch {}
    this.host.remove()
  }
}
