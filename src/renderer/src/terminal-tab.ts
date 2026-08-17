import { Terminal, type IUnicodeVersionProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { backgroundFor, themeForPreset, type Settings } from './themes'
import { t } from './i18n'

export interface TermTabHandlers {
  copySelectionAsAnswer: () => boolean
  openSearch: () => void
  onRequestNewTab: () => void
  onRequestCloseSelf: () => void
  // Ctrl+S：把当前脏分组保存到"已保存分组"
  onRequestSaveGroup?: () => void
  onPtyStarted?: () => void
  // busy 中按 ESC 撤回提示词时 Claude 不发 hook，由 renderer 兜底重置
  onUserAbort?: () => void
  // cc 接口异常（API Error 等）不发 Stop hook，busy 会卡蓝：renderer 扫 PTY 输出命中错误行 → 置 error
  onErrorDetected?: (note?: string) => void
  // pwsh shell integration（OSC 133;C/D + 633;E）上报非 cc 命令的开始/结束，cmdLine 仅 start 时有值
  onShellCommand?: (kind: 'start' | 'end', cmdLine?: string) => void
}

export interface SessionRecord {
  sessionId: string
  source: 'startup' | 'clear' | 'compact' | 'resume'
  createdAt: string
  userTitle?: string
  lastTs?: string
}

export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

// 调试开关：devtools 里执行 `window.__termDebug = true` 打开，关闭时完全 no-op
declare global { interface Window { __termDebug?: boolean; __termDebugDataChars?: number } }
function dbg(...args: unknown[]): void {
  if (typeof window === 'undefined' || !window.__termDebug) return
  const t = performance.now().toFixed(1)
  console.log(`[term] +${t}ms`, ...args)
}
// PTY chunk 预览：默认前 64 codepoint；控制符转义成 \x?? 便于看 ANSI 序列起止
function previewData(d: string): string {
  const max = (typeof window !== 'undefined' && window.__termDebugDataChars) || 64
  const s = d.length > max ? d.slice(0, max) + '…' : d
  return s.replace(/[\x00-\x1f\x7f]/g, (c) =>
    c === '\x1b' ? '\\x1b' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')
  )
}

// OSC 52 的 Pd 是 UTF-8 字节流的 base64：atob 得 latin1 字节串须再按 UTF-8 解码，否则中文/emoji 乱码；失败返回空串
function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

// cc 报 API Error 时不发 Stop hook，错误行是打到 PTY 的可见文本（唯一痕迹），扫到即置 error。keyword → 中文 note。
const CC_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Connection closed mid-response/i, '连接中断，回复可能未完成'],
  [/API Error:\s*(?:Connection error|fetch failed|network)/i, '接口连接异常'],
  [/API Error:\s*(?:Request timed out|timeout)/i, '接口请求超时'],
  [/API Error:\s*5\d\d\b|overloaded/i, '服务端过载/异常'],
  [/API Error:/i, '接口异常'] // 兜底：其余 API Error 一律红点
]
// 合并正则先快筛，命中再定位具体 note
const CC_ERROR_RE = new RegExp(CC_ERROR_PATTERNS.map(([re]) => re.source).join('|'), 'i')

/*
 * 输入子系统要点（bind* 分工）：cc 是 PTY 内全屏 TUI，同一动作会被浏览器/xterm/cc 三层各解读一遍，
 * app 要接管的必须在到达下一层前拦死，交给 cc 的（普通输入/左键选择/滚轮）完整透传。
 * 键盘：IME 接管键拦掉；Ctrl+V 须在 keydown 拦（xterm 会译成 \x16 并吞掉浏览器 paste 事件）。
 * 鼠标：右键 mousedown capture 拦掉，防 cc 把 mouse report 当自己的粘贴重复粘两次。
 * IME：compositionend 手动 send，再开 100ms 窗口抑制 xterm 从过时 buffer 错发的假合成串。
 * 选区缓存：仅服务应用层复制，实时选区被清掉时 1.5s 内可回退；cc 等 TUI 的复制走 OSC52。
 * 出口：sendInput 唯一出口；剪贴板读写优先主进程 Electron clipboard，失败回退浏览器 API。
 * OSC52：xterm 不内置，自己接并解码写剪贴板，否则 cc 复制写不进系统剪贴板。
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
  // cc 进程是否活跃：SessionStart hook → true；任意 pwsh shell integration OSC → false
  // （cc 屏蔽 pwsh 序列，触发即证明 pwsh 前台）。不持久化，重启后按事件重新推导。
  ccActive: boolean = false

  readonly host: HTMLDivElement
  readonly term: Terminal
  readonly fit: FitAddon
  readonly search: SearchAddon
  private readonly serializer: SerializeAddon

  ptyId: number | null = null
  private pendingInput = ''
  private waitingForRestart = false
  private disposed = false
  private handlers: TermTabHandlers

  // 选区缓存
  private lastSelection = ''
  private lastSelectionAt = 0
  private static readonly SEL_FALLBACK_MS = 1500

  // IME 守卫
  private composing = false
  private suppressOnDataUntil = 0
  private static readonly POST_COMPOSE_SUPPRESS_MS = 100

  // OSC 633;E 上报的下一条命令行，落到 133;C 时消费
  private pendingShellCmd: string | undefined

  // cc 错误兜底：errScanTail 存上一 chunk 末尾，拼接后再扫，避免错误行被 chunk 边界切开漏匹配
  private errScanTail = ''
  private static readonly ERR_SCAN_TAIL_LEN = 80

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
      // windowsPty 让 xterm 按 ConPTY 语义处理换行/reflow；仅 Windows 需要，其它平台设了反而不对
      ...(window.term.platform === 'win32'
        ? { windowsPty: { backend: 'conpty' as const } }
        : {})
    })

    this.fit = new FitAddon()
    this.search = new SearchAddon()
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.term.loadAddon(this.serializer)
    // 宽度表对齐：xterm 内置 Unicode 6 宽度表把 emoji 记 1 格，cc（string-width）按 2 格打印，
    // 错位导致选中重绘整段平移，切 Unicode 11 对齐；U+FE0F 变体符号仍差 1 格，故捕获 addon
    // 的 provider 包装成「基字符+U+FE0F 强制宽 2」再注册覆盖 '11'。
    let baseV11: IUnicodeVersionProvider | undefined
    new Unicode11Addon().activate({
      unicode: { register: (p: IUnicodeVersionProvider) => (baseV11 = p) }
    } as unknown as Terminal)
    if (baseV11) {
      const base = baseV11
      const patched: IUnicodeVersionProvider = {
        version: '11',
        wcwidth: (cp) => base.wcwidth(cp),
        // packed 布局：bit0=shouldJoin，bit1-2=width。U+FE0F 时清宽度位再置 2。
        charProperties: (cp, preceding) => {
          const r = base.charProperties(cp, preceding)
          return cp === 0xfe0f ? (r & ~0b110) | 0b100 : r
        }
      }
      ;(this.term.unicode as unknown as { register(p: IUnicodeVersionProvider): void }).register(patched)
    } else {
      // 捕获失败兜底：退回原始 Unicode11，至少纯 emoji 对齐
      this.term.loadAddon(new Unicode11Addon())
    }
    this.term.unicode.activeVersion = '11'
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        void window.term.openExternal(uri)
      })
    )

    // 键盘 + 输出守卫 + OSC 处理不依赖 mount，构造期间挂上
    this.bindKeyboard()
    this.bindOnData()
    this.bindClipboardOsc()
    this.bindShellIntegrationOsc()
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.host)
    this.term.open(this.host)
    this.disableReflow()
    // 渲染器固定用 DOM renderer，不挂 WebGL：WebGL 曾出现"切 tab 后整列左移 1 cell"残影
    //（分数缩放 dpr 下纹理图集对齐坑），且本负载下 DOM 渲染毫无压力、更可预测。
    try { this.fit.fit() } catch {}
    // 右键、粘贴、选区缓存、IME 守卫依赖 host 已挂上 DOM
    this.bindContextMenu()
    this.bindPasteHandler()
    this.bindSelectionCache()
    this.bindIMEGuard()
  }

  // 关闭 xterm 的 resize reflow：cols 真变化时 xterm 会重折 scrollback 里的 wrapped 历史行，
  // 而 cc 收到 SIGWINCH 只重画视口不重画历史，错位固化进 buffer；关掉后 cols 变小只截断右侧。
  //（切 tab 的必现错位另有真凶：same-size PTY resize 惊动 ConPTY 自身 reflow，已在 refit() 根治。）
  // xterm 无公开开关，只能在 normal/alt 两个内部 Buffer 实例上用数据属性遮蔽原型 getter。
  // 私有 API：升级 xterm 时需复核 _core._bufferService.buffers 路径。
  private disableReflow(): void {
    try {
      const core = (this.term as unknown as {
        _core?: { _bufferService?: { buffers?: { normal?: object; alt?: object } } }
      })._core
      const buffers = core?._bufferService?.buffers
      const targets = [buffers?.normal, buffers?.alt].filter(Boolean) as object[]
      if (targets.length === 0) {
        console.warn('[term] disableReflow: 未命中 buffer 路径，reflow 未关（xterm 私有结构可能已变）')
        return
      }
      for (const buf of targets) {
        Object.defineProperty(buf, '_isReflowEnabled', { value: false, configurable: true })
      }
      // 读回验证遮蔽是否生效（仅 __termDebug 下打印）
      const rbNormal = (buffers as { normal?: { _isReflowEnabled?: unknown } })?.normal?._isReflowEnabled
      const rbAlt = (buffers as { alt?: { _isReflowEnabled?: unknown } })?.alt?._isReflowEnabled
      dbg(this.id, `disableReflow: targets=${targets.length} normal._isReflowEnabled=${rbNormal} alt._isReflowEnabled=${rbAlt}`)
    } catch (e) {
      console.warn('[term] disableReflow failed', e)
    }
  }

  // ── 输入子系统 ──

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
        // Ctrl+S：保存当前分组（顺带挡掉 XOFF，裸 \x13 会把终端"冻住"）
        if (e.key === 's' || e.key === 'S') { this.handlers.onRequestSaveGroup?.(); return false }
        // Ctrl+P：命令面板由 CommandPalette 处理，这里只挡住 xterm 把它译成 pty 输入
        if (e.key === 'p' || e.key === 'P') return false
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
      // Ctrl+V / Ctrl+Shift+V 须在 keydown 拦截手动粘贴：xterm 会把 Ctrl+V 译成 \x16 并
      // preventDefault，浏览器 paste 事件不触发；而 cc 只认 bracketed paste、不认裸 \x16。
      // preventDefault 防原生 paste 重复，return false 防 xterm 继续译成 \x16。
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
      // compositionend 后短窗口内拦掉 xterm 从过时 buffer 发的假合成串（真结果已手动 send）；
      // 鼠标追踪/功能键的 onData 以 ESC 开头，放行。
      if (Date.now() < this.suppressOnDataUntil && d.length > 0 && d.charCodeAt(0) !== 0x1b) return
      this.sendInput(d)
    })
  }

  // OSC 52 剪贴板写：xterm core 不内置 52，不接的话 cc 复制永远写不进系统剪贴板（cc 仍乐观
  // 提示 copied）。payload 形如 "Pc;Pd"，Pd=base64(UTF-8) 或 '?'(查询)。走主进程 clipboard。
  private bindClipboardOsc(): void {
    try {
      this.term.parser.registerOscHandler(52, (data) => {
        const sep = data.indexOf(';')
        const payload = sep >= 0 ? data.slice(sep + 1) : data
        // Pd='?' 是读剪贴板请求：出于安全直接吞掉不回应
        if (!payload || payload === '?') return true
        const text = decodeBase64Utf8(payload)
        if (text) void this.writeToClipboard(text)
        return true
      })
    } catch (e) {
      console.warn('[term] OSC52 clipboard handler register failed', e)
    }
  }

  // OSC 133/633：pwsh shell-integration 发的命令生命周期信号（133;A prompt / 133;C 开始 /
  // 133;D 结束；633;E;<cmdline> 命令行原文，在 C 之前发）。registerOscHandler 的 data 是
  // OSC id 与首个「;」之后的剩余串。这里只发布事件不判定 cc、不改 status，决策在 main.ts。
  private bindShellIntegrationOsc(): void {
    try {
      this.term.parser.registerOscHandler(133, (data) => {
        const semi = data.indexOf(';')
        const marker = (semi >= 0 ? data.slice(0, semi) : data).toUpperCase()
        if (marker === 'C') {
          const cmd = this.pendingShellCmd
          this.pendingShellCmd = undefined
          this.handlers.onShellCommand?.('start', cmd)
        } else if (marker === 'D' || marker === 'A') {
          // A / D 都视为「回到 prompt」→ 命令结束
          this.handlers.onShellCommand?.('end')
        }
        return true
      })
      this.term.parser.registerOscHandler(633, (data) => {
        const semi = data.indexOf(';')
        const marker = (semi >= 0 ? data.slice(0, semi) : data).toUpperCase()
        if (marker === 'E') {
          // 保留命令行全部原文，main.ts 里再做 cc 匹配
          this.pendingShellCmd = semi >= 0 ? data.slice(semi + 1) : ''
        }
        return true
      })
    } catch (e) {
      console.warn('[term] shell-integration OSC handler register failed', e)
    }
  }

  private bindContextMenu(): void {
    // capture 阶段拦掉右键 mousedown：否则 cc 在鼠标追踪模式下会收到右键 mouse report
    // 并当成自己的粘贴，与下面的 contextmenu 粘贴重复两次。contextmenu 独立冒泡不受影响。
    this.host.addEventListener('mousedown', (e) => {
      if (e.button === 2) e.stopPropagation()
    }, true)

    // 滚轮不拦：cc 鼠标追踪 / 普通 pwsh 本地 scrollback 两套都对，无需插手

    // Windows Terminal 风格：有选区→复制，无选区→粘贴
    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.copySelectionIfAny()) void this.pasteFromClipboard()
    })
  }

  // 浏览器原生 paste 事件兜底（如 Shift+Insert；Ctrl+V 已在 keydown 拦截不走这里）：
  // capture 拦下自己读剪贴板（主进程能拿 files），stopPropagation 防 xterm 重复 paste。
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
    // capture 阶段：保证标志在 xterm 处理 composition 之前生效
    this.host.addEventListener('compositionstart', () => {
      this.composing = true
    }, true)
    this.host.addEventListener('compositionend', (e) => {
      const data = (e as CompositionEvent).data ?? ''
      this.composing = false
      // 100ms 内挡掉 xterm 即将从过时 buffer 发出的假合成串
      this.suppressOnDataUntil = Date.now() + TerminalTab.POST_COMPOSE_SUPPRESS_MS
      if (data) this.sendInput(data)
    }, true)
  }

  // 实时选区优先；为空时 1.5s 窗口内回退缓存（选区可能刚被 clearSelection / 输出刷新清掉）
  private pickSelection(): string {
    const live = this.term.getSelection()
    if (live) return live
    if (this.lastSelection && Date.now() - this.lastSelectionAt < TerminalTab.SEL_FALLBACK_MS) {
      return this.lastSelection
    }
    return ''
  }

  // 复制统一入口（Ctrl+C / Ctrl+Shift+C / 右键共用）：返回是否实际复制了内容
  private copySelectionIfAny(): boolean {
    const sel = this.pickSelection()
    if (!sel) return false
    void this.writeToClipboard(sel)
    this.term.clearSelection()
    this.lastSelection = ''
    return true
  }

  // 写剪贴板：优先主进程 Electron clipboard（不受焦点/权限影响），失败回退浏览器 API
  private async writeToClipboard(text: string): Promise<void> {
    try {
      const ok = await window.term.writeClipboard(text)
      if (ok) return
    } catch {}
    try { await navigator.clipboard.writeText(text) } catch {}
  }

  // 粘贴统一入口。读/写必须分离：若把 term.paste 放进读取的 try，paste 抛错会掉进 catch
  // 触发浏览器回退、同一内容粘两次。
  private async pasteFromClipboard(): Promise<void> {
    const text = await this.readClipboardText()
    this.pasteText(text)
  }

  // 剪贴板归一成"待粘贴文本"：files → 绝对路径串（含空格加引号）；text → 原样。
  // 优先主进程（能识别 CF_HDROP 文件列表），仅读取异常才回退浏览器 Clipboard API。
  private async readClipboardText(): Promise<string> {
    try {
      const data = await window.term.readClipboard()
      switch (data?.kind) {
        case 'files': return formatPathListForShell(data.files)
        case 'text': return data.text
        case 'empty': return ''
        default: {
          // 协议兜底：主进程返回非 discriminated 结构时（如 dev 热重载版本错位）尽力恢复
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

  // 实际写入终端：cc 开启 bracketed paste 时 xterm 自动用 \x1b[200~..201~ 包裹
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

  // ── PTY 生命周期 ──

  async startPty(): Promise<void> {
    if (this.disposed) return
    dbg(this.id, 'startPty: requesting create', { cols: this.term.cols, rows: this.term.rows, cwd: this.cwd })
    try {
      const id = await window.term.create({
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.cwd,
        tabId: this.id,
        tabName: this.name
      })
      // create 期间 tab 可能已 dispose（ptyId 尚为 null，dispose 杀不到）：立即 kill 防进程泄漏
      if (this.disposed) {
        window.term.kill(id)
        return
      }
      this.ptyId = id
      dbg(this.id, 'startPty: created ptyId=' + id, { cols: this.term.cols, rows: this.term.rows })
      if (this.pendingInput) {
        window.term.send(id, this.pendingInput)
        this.pendingInput = ''
      }
      this.handlers.onPtyStarted?.()
    } catch (e) {
      // IPC 报错原文兜底翻译一层
      const msg = t((e as Error)?.message || String(e))
      this.status = 'error'
      this.note = msg
      this.term.writeln('')
      this.term.writeln('\x1b[31m' + t('[启动 shell 失败] {0}', msg) + '\x1b[0m')
      this.term.writeln('\x1b[90m' + t('请检查分组的路径是否仍存在，按任意键重试。') + '\x1b[0m')
      this.waitingForRestart = true
    }
  }

  writeFromPty(data: string): void {
    if (typeof window !== 'undefined' && window.__termDebug) {
      dbg(this.id, `data ${data.length}B`, previewData(data))
    }
    this.term.write(data)
    this.scanForError(data)
  }

  // 只在 busy 时扫错误行（省开销 + 天然去抖：命中后 status 变 error 即停）
  private scanForError(data: string): void {
    if (this.status !== 'busy') {
      this.errScanTail = ''
      return
    }
    const hay = this.errScanTail + data
    if (CC_ERROR_RE.test(hay)) {
      const hit = CC_ERROR_PATTERNS.find(([re]) => re.test(hay))
      this.errScanTail = ''
      this.status = 'error'
      this.handlers.onErrorDetected?.(t(hit?.[1] ?? '接口异常'))
      return
    }
    // 只留末尾一小段做跨 chunk 拼接，避免无限增长
    this.errScanTail = hay.length > TerminalTab.ERR_SCAN_TAIL_LEN
      ? hay.slice(-TerminalTab.ERR_SCAN_TAIL_LEN)
      : hay
  }

  // cc 等全屏 TUI 崩溃退出时不会复位自己开过的鼠标/焦点追踪模式，xterm 仍保持追踪态：
  // 鼠标一动就朝 pwsh 狂发上报序列（鼠标 [<..M、焦点 [I/[O），pwsh 回显成乱码并误触发
  // PSReadLine（digit-argument 等），Ctrl+C 治不了、只能关标签重开。cc→pwsh 边沿
  //（controller 翻 ccActive 处）调用本方法无条件复位这些输入上报模式即可根治：此刻前台
  // 一定是 pwsh，而 pwsh 提示符永不需要鼠标/焦点追踪，故 cc 正常退出时重发也是纯 no-op。
  // 刻意只关追踪类：不碰 bracketed paste(?2004，pwsh 粘贴要用) 与备用屏(?1049)。
  resetInputTrackingModes(): void {
    // 关鼠标追踪(X10/VT200/button/any-event) + 焦点追踪 + 各上报编码(UTF-8/SGR/urxvt/pixel)。
    // 写给 xterm（非 PTY）：直接清 xterm 的 CoreMouseService，之后鼠标移动不再生成上报。
    try {
      this.term.write('\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016l')
    } catch {}
  }

  handlePtyExit(exitCode: number): void {
    this.ptyId = null
    this.term.writeln('')
    this.term.writeln('\x1b[90m' + t('[pwsh 已退出 · 退出码 {0}]', exitCode) + '\x1b[0m')
    this.term.writeln('\x1b[90m' + t('按任意键重启 shell…') + '\x1b[0m')
    this.waitingForRestart = true
  }

  // 切换会话：kill 当前 PTY、清屏、重新 spawn（launchCC 会按新 activeSessionId 走 resume）
  async restartPty(): Promise<void> {
    if (this.disposed) return
    if (this.ptyId != null) {
      window.term.kill(this.ptyId)
      this.ptyId = null
    }
    this.term.reset()
    // reset() 会 new 全新的 normal/alt Buffer 实例，mount 时的 reflow 遮蔽随之失效，
    // 必须重新遮蔽，否则切/删会话后 reflow 静默复活、真·改宽时再次错位。
    this.disableReflow()
    this.waitingForRestart = false
    await this.startPty()
  }

  refit(): void {
    const before = { cols: this.term.cols, rows: this.term.rows }
    try { this.fit.fit() } catch (e) { dbg(this.id, 'refit: fit threw', e) }
    const after = { cols: this.term.cols, rows: this.term.rows }
    const changed = before.cols !== after.cols || before.rows !== after.rows
    if (changed) {
      dbg(this.id, 'refit: cols/rows changed', before, '->', after)
    } else {
      dbg(this.id, 'refit: cols/rows unchanged', after)
    }
    // 只在网格真变化时才把 resize 推给 PTY：same-size resize 会惊动 ConPTY 自身的 reflow
    //（在数据进 xterm 之前做，disableReflow 管不到），把宽表历史行重折错位灌进 buffer ——
    // 这正是"切 tab 时错位"的真凶。尺寸没变就不惊动 PTY，由 setActive 的 refresh 重画。
    if (this.ptyId != null && changed) {
      dbg(this.id, `refit: push PTY resize ptyId=${this.ptyId}`, after)
      window.term.resize(this.ptyId, this.term.cols, this.term.rows)
    }
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
    const before = { cols: this.term.cols, rows: this.term.rows }
    try { this.fit.fit() } catch {}
    const changed = before.cols !== this.term.cols || before.rows !== this.term.rows
    // 只在网格真变化时 resize PTY：same-size resize 会惊动 ConPTY reflow 错位历史，
    // 与 refit() 同一道防线。
    if (this.ptyId != null && changed) window.term.resize(this.ptyId, this.term.cols, this.term.rows)
  }

  setActive(active: boolean): void {
    dbg(this.id, `setActive(${active})`, { cols: this.term.cols, rows: this.term.rows })
    this.host.classList.toggle('active', active)
    if (!active) return
    // 调试：把当前 active 的 term 挂到 window，devtools 里深挖 buffer 状态
    ;(window as unknown as { __activeTerm?: unknown }).__activeTerm = this.term
    // display:none→block 后浏览器要 1 帧才 reflow，立刻 refit 会拿旧高度算错 cols/rows
    // 推给 PTY，cc 按错误尺寸重画；推迟到下一帧、布局稳定后再 fit。
    requestAnimationFrame(() => {
      // 一帧内本 tab 可能已 dispose：focus() 会打在已销毁的 textarea 上抛未捕获异常
      if (this.disposed) return
      dbg(this.id, 'setActive rAF: about to refit')
      this.refit()
      // display:none→block 后 xterm 不自动重绘；refit 未变尺寸时不触发重画，兜底刷一次
      try { this.term.refresh(0, Math.max(0, this.term.rows - 1)) } catch {}
      this.term.focus()
      dbg(this.id, 'setActive rAF: done')
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.ptyId != null) {
      window.term.kill(this.ptyId)
      this.ptyId = null
    }
    try { this.term.dispose() } catch {}
    this.host.remove()
  }

  // ── 跨窗口迁移（拖出/拖回独立窗口） ──

  // 整个 scrollback + 视口 + 光标/模式状态打包成 ANSI 序列，目标窗口原样 write 即可重现。
  // 失败返回空串（画面丢失但 PTY 照常接管，可接受降级）。
  serializeBuffer(): string {
    try {
      return this.serializer.serialize()
    } catch (e) {
      console.warn('[term] serialize failed', e)
      return ''
    }
  }

  // 迁出：销毁 xterm 与 DOM，但不杀 PTY（进程交给目标窗口继续用）
  detach(): void {
    if (this.disposed) return
    this.disposed = true
    this.ptyId = null // 先摘走引用，绝不能走到 kill
    try { this.term.dispose() } catch {}
    this.host.remove()
  }

  // 迁入：接管已存在的 PTY。调用方需先 write 序列化缓冲再 adopt，adopt 后 refit
  // 一次把新窗口的真实尺寸推给 PTY。
  adoptPty(id: number): void {
    if (this.disposed) return
    this.ptyId = id
    if (this.pendingInput) {
      window.term.send(id, this.pendingInput)
      this.pendingInput = ''
    }
  }
}

// 把文件路径拼成 PowerShell 命令行串：含空格加双引号（Windows 路径不含 "，基础转义足够）
function formatPathListForShell(files: string[]): string {
  return files
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
}
