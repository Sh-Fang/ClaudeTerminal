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
  // 用户在 busy 中按 ESC 撤回提示词时，Claude 不会发 hook，由 renderer 兜底重置
  onUserAbort?: () => void
}

export interface SessionRecord {
  sessionId: string
  source: 'startup' | 'clear' | 'compact' | 'resume'
  createdAt: string
  aiTitle?: string
  userTitle?: string
  lastTs?: string
}

export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

/*
 * ───────────────────────────────────────────────────────────────────
 * 输入子系统总览（bind* 的职责分工）
 * ───────────────────────────────────────────────────────────────────
 * 根本难点：cc 是跑在 PTY 里的全屏 TUI（alt-screen + bracketed paste +
 * 鼠标追踪 + raw mode）。同一个用户动作往往被 浏览器 / xterm / cc 三层
 * 各自解读一遍。核心原则：凡 app 要接管的动作，必须在它到达"另一个也想
 * 处理它的层"之前拦死；凡要交给 cc 的（普通输入、左键选择、滚轮）完整透传。
 *
 * 键盘  attachCustomKeyEventHandler ─ xterm 的 keydown 入口
 *   · IME 接管键（isComposing / keyCode=229 / key='Process'）→ return false
 *     否则 xterm 会把第一颗拼音字母当字符发到 PTY（prompt 里冒出 "zhe'g"）
 *   · 应用快捷键 Ctrl+T/W/F → return false，不透传
 *   · 复制 Ctrl+C（有选区）/ Ctrl+Shift+C → copySelectionIfAny()
 *       Ctrl+C 无选区时 return true，把 SIGINT 透传给 cc
 *   · 粘贴 Ctrl+V / Ctrl+Shift+V → preventDefault + pasteFromClipboard()
 *       不能依赖浏览器 paste 事件：xterm 会把 Ctrl+V 译成 \x16 并 preventDefault，
 *       paste 事件根本不触发（普通 pwsh 下是 PSReadLine 自己接 \x16 才显得正常）
 *   · ESC：busy 时通知 onUserAbort，按键仍透传给 cc
 *
 * 鼠标
 *   · 右键 mousedown（capture 阶段）→ stopPropagation，挡住 xterm 把右键上报成
 *     mouse report 给 cc —— 否则 cc 把右键当自己的粘贴，会和下面的 contextmenu
 *     重复粘两次。左键/移动/滚轮不拦，照常透传给 cc。
 *   · contextmenu → 有选区复制，无选区 pasteFromClipboard()（Win Terminal 风格）
 *
 * 粘贴兜底  bindPasteHandler ─ 浏览器原生 paste 事件（如 Shift+Insert）
 *   Ctrl+V 不走这里（已在 keydown 拦截）
 *
 * IME（capture 阶段先于 xterm 的 textarea bubble 监听）
 *   compositionstart → composing=true
 *   compositionend   → composing=false + 手动 send e.data
 *                    + 开 100ms 窗口抑制 xterm 接着错发的"过时 buffer"
 *     （alt-screen 下 xterm 的 textarea buffer 不被 insertCompositionText 更新，
 *      每次 compositionend 都会 emit 第一次锁住的老内容，只能我们自己接管）
 *
 * 选区缓存  onSelectionChange → 非空时记录文本+时间戳
 *   cc 刷屏会清掉 xterm 实时选区，复制时 1.5s 内可回退到缓存
 *
 * 出口
 *   sendInput(d) ─ 唯一出口，处理 waitingForRestart / pendingInput 兜底
 *   term.onData(d) → composing 中丢弃；compositionend 后短窗口内首字节非 ESC 丢弃
 *
 * 剪贴板读写（都优先走主进程 Electron clipboard，再回退浏览器 Clipboard API）
 *   写 writeToClipboard(text)
 *   读 readClipboardText()：files → 绝对路径串（含空格加引号）；text → 原样
 * ───────────────────────────────────────────────────────────────────
 */

export class TerminalTab {
  readonly id: string
  name: string
  cwd: string
  sessions: SessionRecord[]
  activeSessionId: string | undefined
  autoLaunchCC: boolean
  status: TabStatus
  note?: string
  dirty: boolean

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

  // ── 输入子系统：选区缓存 ────────────────────────────────────
  private lastSelection = ''
  private lastSelectionAt = 0
  private static readonly SEL_FALLBACK_MS = 1500

  // ── 输入子系统：IME 守卫 ───────────────────────────────────
  private composing = false
  private suppressOnDataUntil = 0
  private static readonly POST_COMPOSE_SUPPRESS_MS = 100

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
      dirty?: boolean
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
    this.dirty = opts.dirty ?? true
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

    // 输入子系统：键盘 + 输出守卫（不依赖 mount，构造期间挂上）
    this.bindKeyboard()
    this.bindOnData()
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
    // 输入子系统：右键、粘贴、选区缓存、IME 守卫（依赖 host 已经挂上 DOM）
    this.bindContextMenu()
    this.bindPasteHandler()
    this.bindSelectionCache()
    this.bindIMEGuard()
  }

  // ═══════════════════════════════════════════════════════════
  //   输入子系统 ─ 实现
  // ═══════════════════════════════════════════════════════════

  private bindKeyboard(): void {
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // IME 接管中的按键一律拦掉，避免 xterm 把拼音字母当字符发到 PTY
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return false

      // 应用级快捷键：全部不透传到 PTY
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (e.key === 't' || e.key === 'T') { this.handlers.onRequestNewTab(); return false }
        if (e.key === 'w' || e.key === 'W') { this.handlers.onRequestCloseSelf(); return false }
        if (e.key === 'f' || e.key === 'F') { this.handlers.openSearch(); return false }
        if (e.key === 'c' || e.key === 'C') {
          // Ctrl+C：有选区→复制（吃掉按键）；无选区→透传 SIGINT 给 cc
          if (this.copySelectionIfAny()) {
            e.preventDefault()
            return false
          }
          return true
        }
      }
      // Ctrl+Shift+C：强制复制（按键永不透传，即便无选区）
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        this.copySelectionIfAny()
        return false
      }
      // Ctrl+V / Ctrl+Shift+V：统一在 keydown 主动拦截，手动走 pasteFromClipboard。
      // 不能依赖浏览器原生 paste 事件：xterm 会先把 Ctrl+V 译成 \x16(SYN) 发给 PTY，
      // 并对该 keydown 调 preventDefault —— 浏览器的 paste 事件因此根本不触发，
      // bindPasteHandler 收不到。普通 pwsh 下 PSReadLine 恰好把 \x16 当"粘贴"才显得
      // 正常，cc 的 TUI 只认 bracketed paste、不认裸 \x16，于是表现为"无反应"。
      // 这里 preventDefault 阻止浏览器原生 paste（避免与 bindPasteHandler 重复），
      // return false 阻止 xterm 继续把按键译成 \x16。
      if (e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        void this.pasteFromClipboard()
        return false
      }

      // ESC：busy 时 Claude 不发 hook，渲染层兜底降级。按键仍透传给 cc。
      if (e.key === 'Escape' && this.status === 'busy') {
        this.handlers.onUserAbort?.()
      }
      return true
    })
  }

  private bindOnData(): void {
    this.term.onData((d) => {
      if (this.composing) return
      // compositionend 后短窗口：xterm 会从过时 buffer 发一段假合成串。
      // 真正的合成结果已经在 compositionend 里手动 send；这里把假货拦掉。
      // 鼠标追踪 / 功能键的 onData 都以 ESC(0x1B) 开头，放行不拦。
      if (Date.now() < this.suppressOnDataUntil && d.length > 0 && d.charCodeAt(0) !== 0x1b) return
      this.sendInput(d)
    })
  }

  private bindContextMenu(): void {
    // 右键完全交给 app 做复制/粘贴：capture 阶段拦掉右键的 mousedown 并 stopPropagation，
    // 阻止它向下传到 xterm 的 mousedown 监听 —— 否则 cc 在鼠标追踪模式下会收到右键的
    // mouse report (\x1b[<2;..M/m) 并把右键当成自己的粘贴，于是"粘贴两次"
    //（cc 自己右键粘一次 + 下面 contextmenu 再 paste 一次）。
    // contextmenu 是独立事件，照常冒泡到下面的 handler，不受影响。
    this.host.addEventListener('mousedown', (e) => {
      if (e.button === 2) e.stopPropagation()
    }, true)

    // alt-screen（cc TUI）下 xterm 默认把滚轮转成 cursor key（↑/↓）发给 PTY，
    // cc 把它当方向键 → 在输入框里移动光标，是个明显的回归。我们已剥掉鼠标追踪
    // 序列，cc 收不到滚轮 mouse report，alt-screen 本就没 scrollback 可滚。
    // 解决：在 alt-screen 下拦截 xterm 的默认转换，自己把滚轮换成 PgUp/PgDn 发给
    // PTY —— cc 的应用层用 PgUp/PgDn 翻看历史输出，且 cc 输入框不消费这俩键。
    // 单次滚轮的 deltaY 大约 100px ≈ 1 行，按比例换算成 1~6 次 PgUp/PgDn。
    this.host.addEventListener('wheel', (e) => {
      const buffer = this.term.buffer.active
      const isAltScreen = buffer && buffer.type === 'alternate'
      if (!isAltScreen) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (this.ptyId == null) return
      const steps = Math.min(6, Math.max(1, Math.round(Math.abs(e.deltaY) / 100)))
      const key = e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~' // PgUp / PgDn
      window.term.send(this.ptyId, key.repeat(steps))
    }, { capture: true, passive: false })

    // Windows Terminal 风格：有选区→复制，无选区→粘贴
    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.copySelectionIfAny()) void this.pasteFromClipboard()
    })
  }

  // 浏览器原生 paste 事件兜底（如 Shift+Insert）：capture 阶段拦下来，自己读剪贴板。
  // Ctrl+V 不走这里 —— 它在 keydown 已被主动拦截（xterm 会 preventDefault 吞掉 paste 事件）。
  // 主进程能拿到 files 而 xterm 自带 paste handler 只能拿 text，所以接管。
  // stopPropagation 阻止事件继续传到 xterm 的 textarea listener，避免重复 paste。
  private bindPasteHandler(): void {
    this.host.addEventListener('paste', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.pasteFromClipboard()
    }, true)
  }

  private bindSelectionCache(): void {
    try {
      this.term.onSelectionChange(() => {
        const s = this.term.getSelection()
        if (s) {
          this.lastSelection = s
          this.lastSelectionAt = Date.now()
        }
      })
    } catch {}
  }

  private bindIMEGuard(): void {
    // capture 阶段：保证我们的标志在 xterm 自己处理 composition 之前生效
    this.host.addEventListener('compositionstart', () => {
      this.composing = true
    }, true)
    this.host.addEventListener('compositionend', (e) => {
      const data = (e as CompositionEvent).data ?? ''
      this.composing = false
      // 100ms 内挡掉 xterm 即将发出的过时 buffer
      this.suppressOnDataUntil = Date.now() + TerminalTab.POST_COMPOSE_SUPPRESS_MS
      if (data) this.sendInput(data)
    }, true)
  }

  // ── 输入子系统 ─ 辅助 ──────────────────────────────────────

  // 实时选区优先；否则在 1.5s 窗口内回退到缓存（cc 刷屏会清掉实时选区）
  private pickSelection(): string {
    const live = this.term.getSelection()
    if (live) return live
    if (this.lastSelection && Date.now() - this.lastSelectionAt < TerminalTab.SEL_FALLBACK_MS) {
      return this.lastSelection
    }
    return ''
  }

  // 复制操作的统一入口：返回是否实际复制了内容。
  // 三个调用点（Ctrl+C / Ctrl+Shift+C / 右键）共用，避免每处都写一遍清选区+缓存。
  private copySelectionIfAny(): boolean {
    const sel = this.pickSelection()
    if (!sel) return false
    void this.writeToClipboard(sel)
    this.term.clearSelection()
    this.lastSelection = ''
    return true
  }

  // 写剪贴板：优先走主进程 Electron clipboard（最稳，不受 webContents 焦点/权限影响）；
  // 主进程失败再回退到浏览器 Clipboard API
  private async writeToClipboard(text: string): Promise<void> {
    try {
      const ok = await window.term.writeClipboard(text)
      if (ok) return
    } catch {}
    try { await navigator.clipboard.writeText(text) } catch {}
  }

  // 粘贴统一入口：先把剪贴板读成"待粘贴文本"，再写入终端。
  // 读 / 写分离很重要 —— 若把 term.paste 放进读取的 try 里，paste 抛错会掉进
  // catch 触发浏览器回退、把同一份内容再粘一次（重复粘贴）。
  private async pasteFromClipboard(): Promise<void> {
    const text = await this.readClipboardText()
    this.pasteText(text)
  }

  // 把剪贴板内容归一成"待粘贴文本"：
  //   files → 绝对路径串（含空格的路径自动加双引号）
  //   text  → 原样
  //   empty → 空串（主进程是权威源，不再回退）
  // 只有主进程读取异常时才回退到浏览器 Clipboard API。
  // 优先走主进程：它能识别 CF_HDROP 文件列表，浏览器 readText 拿不到文件。
  private async readClipboardText(): Promise<string> {
    try {
      const data = await window.term.readClipboard()
      switch (data?.kind) {
        case 'files': return formatPathListForShell(data.files)
        case 'text': return data.text
        case 'empty': return ''
        default: {
          // 协议兜底：万一主进程返回了非 discriminated 结构（如 dev 热重载期间
          // renderer 已更新而主进程仍是旧版本），尽力从 text/files 字段恢复，
          // 避免静默粘不上。
          const loose = data as unknown as { text?: string; files?: string[] } | undefined
          if (loose?.files?.length) return formatPathListForShell(loose.files)
          if (loose?.text) return loose.text
          return ''
        }
      }
    } catch {
      try { return await navigator.clipboard.readText() } catch { return '' }
    }
  }

  // 实际写入终端。cc 开启 bracketed paste(?2004h) 时 xterm 会自动用
  // \x1b[200~..\x1b[201~ 包裹，cc 据此把整段识别为粘贴内容。
  private pasteText(text: string): void {
    if (!text) return
    try {
      this.term.paste(text)
    } catch (e) {
      console.warn('[term] paste failed', e)
    }
  }

  // 唯一出口：统一处理 waitingForRestart / pendingInput / 实际发送
  private sendInput(d: string): void {
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
  }

  // ═══════════════════════════════════════════════════════════
  //   PTY 生命周期
  // ═══════════════════════════════════════════════════════════

  async startPty(): Promise<void> {
    if (this.disposed) return
    try {
      const id = await window.term.create({
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.cwd,
        tabId: this.id
      })
      // create 期间 tab 可能已被 dispose（此时 ptyId 还是 null，dispose 杀不到）：
      // 立刻 kill 这个新建的 PTY，否则它会变成泄漏的 ConPTY+pwsh 进程。
      if (this.disposed) {
        window.term.kill(id)
        return
      }
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
    this.term.write(stripMouseTracking(data))
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

// 剥掉 PTY 数据流里的"鼠标追踪开关"序列，让 xterm 永不进入鼠标追踪模式。
// 否则 cc 等 TUI 会发 \x1b[?1003h（any-motion 模式），xterm 把所有左键拖动都
// 当 mouse report 发回 PTY → 完全不产生本地选区 → Ctrl+C 找不到内容可复制。
// 命中的 DEC private modes：
//   ?9    X10 mouse / ?1000 normal / ?1001 highlight / ?1002 button-event
//   ?1003 any-event / ?1004 focus-event / ?1005 utf-8 ext / ?1006 SGR ext
//   ?1015 urxvt ext / ?1016 SGR pixel
// 同时剥开(h)与关(l)两端：开剥掉避免进入，关剥掉避免 cc 退出时"还原"开。
// 副作用：cc TUI 里鼠标点击/拖动交互失效（cc 实际操作靠键盘，影响很小），
// 拖选 / 复制 / 滚轮 scrollback 全部恢复成普通终端体验。
const MOUSE_TRACK_RE = /\x1b\[\?(9|1000|1001|1002|1003|1004|1005|1006|1015|1016)[hl]/g
function stripMouseTracking(data: string): string {
  return data.replace(MOUSE_TRACK_RE, '')
}

// 把若干文件路径拼成 PowerShell 命令行风格的字符串。
// 含空格的路径用双引号包起来（Windows 路径不含 " 字符，最基础转义即够用）。
// 过滤掉空项，避免拼出多余空格。若以后要支持 bash/zsh，可在这里按 shell 类型分流转义。
function formatPathListForShell(files: string[]): string {
  return files
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
}
