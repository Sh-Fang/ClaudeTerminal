import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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
  // pwsh shell integration 上报：非 cc 命令的开始/结束（cmdLine 只在 start 时有值）。
  // 由 pwsh profile 通过 OSC 133;C/D + OSC 633;E 序列驱动，用于给纯 pwsh tab 标注运行态。
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

// 调试开关：默认关。devtools 里执行 `window.__termDebug = true` 打开。
// 打开后在切换 tab / fit / resize / startPty / 收到 PTY data 这些关键节点打日志，
// 用来追"切回 tab 出现脏字 / 左移 / splash 错位"这类时序问题。
// 关掉就完全 no-op，不影响性能。
declare global { interface Window { __termDebug?: boolean; __termDebugDataChars?: number } }
function dbg(...args: unknown[]): void {
  if (typeof window === 'undefined' || !window.__termDebug) return
  // 高精度时间戳 + 统一前缀，console 过滤搜 [term] 一次拉全
  const t = performance.now().toFixed(1)
  console.log(`[term] +${t}ms`, ...args)
}
// PTY chunk preview：默认前 64 个 codepoint，避免大段 ANSI 刷爆 console。
// 不可见控制符 (< 0x20 / 0x7f) 渲染成 \x?? 转义，方便看到 ANSI 序列起止。
function previewData(d: string): string {
  const max = (typeof window !== 'undefined' && window.__termDebugDataChars) || 64
  const s = d.length > max ? d.slice(0, max) + '…' : d
  return s.replace(/[\x00-\x1f\x7f]/g, (c) =>
    c === '\x1b' ? '\\x1b' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')
  )
}

// OSC 52 的 Pd 是 UTF-8 字节流的 base64。atob 解出来是 latin1 字节串，必须再按
// UTF-8 解码，否则中文 / emoji 复制出来全是乱码。失败返回空串（调用方据此不写剪贴板）。
function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

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
 *   仅服务于应用层复制 xterm 自身选区（普通 shell）：实时选区被 clearSelection /
 *   输出刷新清掉时，1.5s 内可回退到缓存。cc 等 TUI 的复制走 OSC52，不经这里。
 *
 * 出口
 *   sendInput(d) ─ 唯一出口，处理 waitingForRestart / pendingInput 兜底
 *   term.onData(d) → composing 中丢弃；compositionend 后短窗口内首字节非 ESC 丢弃
 *
 * 剪贴板读写（都优先走主进程 Electron clipboard，再回退浏览器 Clipboard API）
 *   写 writeToClipboard(text)
 *   读 readClipboardText()：files → 绝对路径串（含空格加引号）；text → 原样
 *   OSC52  bindClipboardOsc ─ PTY 内 TUI(cc 等)发 ESC]52 写剪贴板，xterm 不内置 52，
 *          自己接 → 解码 base64 → writeToClipboard。否则 cc 复制写不进系统剪贴板。
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
  // 运行时状态：当下 cc 进程是否活跃。SessionStart hook → true；任意 pwsh shell integration
  // OSC 序列（onShellCommand）→ false（cc 在 alt-screen 里屏蔽 pwsh 序列，触发即证明 pwsh 前台）。
  // 不持久化——仅用于顶栏"启动 CC"按钮显隐等即时判定，重启/恢复后重新根据事件推导。
  ccActive: boolean = false

  readonly host: HTMLDivElement
  readonly term: Terminal
  readonly fit: FitAddon
  readonly search: SearchAddon

  ptyId: number | null = null
  private pendingInput = ''
  private waitingForRestart = false
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

  // ── shell integration：OSC 633;E 上报的下一条命令行，落到 133;C 时消费
  private pendingShellCmd: string | undefined

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

    // 输入子系统：键盘 + 输出守卫 + OSC52 剪贴板（不依赖 mount，构造期间挂上）
    this.bindKeyboard()
    this.bindOnData()
    this.bindClipboardOsc()
    this.bindShellIntegrationOsc()
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.host)
    this.term.open(this.host)
    this.disableReflow()
    // 渲染器：用 xterm 默认的 DOM renderer，不挂 WebGL。
    // WebGL 的实质收益是"GPU 把字形烘成纹理、逐 cell blit"，只在全屏高频重绘时省 CPU——本应用
    // 以 cc 会话为主（中等输出 + 大量阅读/滚动），DOM renderer 毫无压力，用不上这份收益。
    // 而 WebGL 在本应用有实打实的残影前科：63400e0 记录的"切 tab 后下半屏整列左移 1 cell"就是它
    // 干的、clearTextureAtlas 都压不住；且本机 dpr=1.5 分数缩放正是纹理图集半像素对齐的高发坑。
    // DOM 逐行重建、无纹理/几何缓存这层，渲染更可预测。故弃用 WebGL。
    // （注：另有一种"快滚时列 0 顶格内容留竖脏缝"是 Chromium 合成器残留 tile、非渲染器问题，
    //   DOM/WebGL 都有、且只在个别 cc 会话写坏的历史 buffer 上复现，与这里的取舍无关。）
    try { this.fit.fit() } catch {}
    // 输入子系统：右键、粘贴、选区缓存、IME 守卫（依赖 host 已经挂上 DOM）
    this.bindContextMenu()
    this.bindPasteHandler()
    this.bindSelectionCache()
    this.bindIMEGuard()
  }

  // 关闭 xterm 的 resize reflow（重折行）。
  // cc 是 normal-buffer 全屏 TUI（能往上滚看历史 → 不是 alt-screen），它靠 autowrap 换行的
  // 宽行会被 xterm 标记为 wrapped（"一条逻辑长行折成几行"）。当 cols 真的变化时（拖窗口 /
  // 多屏 dpr 变化），xterm 会对 scrollback 里这些 wrapped 历史行做 reflow：每行行首几个字符
  // 被挪到上一行尾、错位逐行累积（sync→sy+nc）。而 cc 收到 SIGWINCH 只重画当前视口、不重画
  // 已滚上去的历史行，于是错位固化在 buffer 里，refresh 只会把这份脏 buffer 原样重画。
  // 关掉后：cols 变小只截断历史行右侧（xterm 无横向滚动），不再错位 —— 对以跑 cc 为主的终端稳赚。
  //
  // 分工要分清：切 tab 那种"必现"的错位不归本函数管 —— 它 cols 根本没变、走不到 xterm reflow。
  // 那份真凶是 refit() 以前无脑发的 same-size PTY resize 惊动了 ConPTY 自己的 reflow（在数据
  // 进 xterm 之前就做，本函数够不着），已在 refit() 里用"尺寸没变就不 resize"根治。本函数只负责
  // "真·改变尺寸"时 xterm 这一侧的 reflow。与字体 / 连字 / DOM·WebGL 渲染器都无关。
  //
  // xterm 没有"保留 scrollback 又关 reflow"的公开开关：现代 ConPTY 下 Buffer 的
  // _isReflowEnabled getter 恒为 true（_hasScrollback && backend==='conpty' && buildNumber>=21376）。
  // 只能在 normal / alt 两个内部 Buffer 实例上，用实例数据属性遮蔽原型上的 getter。
  // 私有 API：升级 xterm 时需复核 _core._bufferService.buffers 这条路径。
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
      // 读回验证：确认遮蔽 getter 生效（仅在 __termDebug 下打印，排查"到底关没关上"）
      const rbNormal = (buffers as { normal?: { _isReflowEnabled?: unknown } })?.normal?._isReflowEnabled
      const rbAlt = (buffers as { alt?: { _isReflowEnabled?: unknown } })?.alt?._isReflowEnabled
      dbg(this.id, `disableReflow: targets=${targets.length} normal._isReflowEnabled=${rbNormal} alt._isReflowEnabled=${rbAlt}`)
    } catch (e) {
      console.warn('[term] disableReflow failed', e)
    }
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
        // Ctrl+P：命令面板(由 CommandPalette 在 window capture 阶段自行处理)。
        // 这里只负责不让 xterm 把它译成 pty 输入(pwsh PSReadLine 会把 Ctrl+P 当"历史上一条")。
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

  // OSC 52 剪贴板写：cc 等 PTY 内 TUI 在鼠标追踪模式下自己管理选区，复制时不走
  // 应用层的 copySelectionIfAny，而是发 ESC]52;Pc;Pd ST 让终端把内容落到系统剪贴板。
  // xterm core 不内置 52（只注册了 0/1/2/4/8/10/11/12/104/110/111/112），不接的话
  // cc 的复制永远写不进剪贴板 —— cc 发完仍乐观提示 "copied N chars"，但剪贴板里是空的，
  // 表现为"提示复制成功、Win+V 却找不到，要试 3~4 次 cc 降级到本地剪贴板后才行"。
  // 这里自己接：payload 形如 "Pc;Pd"，Pc=目标选择符(忽略)，Pd=base64(UTF-8) 或 '?'(查询)。
  // 复用 writeToClipboard 走主进程 Electron clipboard，不受 navigator.clipboard 的焦点/权限限制。
  private bindClipboardOsc(): void {
    try {
      this.term.parser.registerOscHandler(52, (data) => {
        const sep = data.indexOf(';')
        const payload = sep >= 0 ? data.slice(sep + 1) : data
        // Pd='?' 是"读剪贴板"请求：出于安全不回应（避免 TUI 偷读剪贴板），直接吞掉
        if (!payload || payload === '?') return true
        const text = decodeBase64Utf8(payload)
        if (text) void this.writeToClipboard(text)
        return true // 已处理，阻止 xterm 把它当未知 OSC 继续往下抛
      })
    } catch (e) {
      console.warn('[term] OSC52 clipboard handler register failed', e)
    }
  }

  // OSC 133 / 633：pwsh shell-integration.ps1 发的 shell 命令生命周期信号。
  //   OSC 133;A   prompt 开始 → 当作 idle 兜底
  //   OSC 133;C   命令开始    → busy
  //   OSC 133;D   命令结束    → idle
  //   OSC 633;E;<cmdline>  命令行原文（在 C 之前发），用于过滤 cc 自身
  //
  // xterm 的 parser.registerOscHandler(id, cb)：cb 接到的 data 是「;」后剩下的字符串。
  // 例如原序列 `\x1b]133;C\x07`，data = 'C'；`\x1b]633;E;claude --resume xxx\x07`，data = 'E;claude ...'。
  // 返回 true 表示已处理，阻止 xterm 把它当未知 OSC 继续抛出。
  //
  // 只发布事件，不在这里判定 cc / 也不改 status —— main.ts 负责决策（要读 settings.claudePath、
  // 要判 tab.autoLaunchCC / activeSessionId），把状态推到 sidebar。
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
          // A / D 都视为「回到 prompt」→ 命令结束。首个 A 触发的 end 是空转，无副作用。
          this.handlers.onShellCommand?.('end')
        }
        return true
      })
      this.term.parser.registerOscHandler(633, (data) => {
        const semi = data.indexOf(';')
        const marker = (semi >= 0 ? data.slice(0, semi) : data).toUpperCase()
        if (marker === 'E') {
          // E;<cmdline>  ——  保留全部原文，main.ts 里再做 cc 匹配
          this.pendingShellCmd = semi >= 0 ? data.slice(semi + 1) : ''
        }
        return true
      })
    } catch (e) {
      console.warn('[term] shell-integration OSC handler register failed', e)
    }
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

    // 滚轮不拦：cc 启用鼠标追踪后，xterm 把 wheel 上报成 mouse report，cc 自己
    // 处理为行级滚动；普通 pwsh 下 xterm 走本地 scrollback。两套都对，不需要我们插手。

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

  // 实时选区优先；为空时在 1.5s 窗口内回退到缓存（选区可能刚被 clearSelection / 输出刷新清掉）
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
    dbg(this.id, 'startPty: requesting create', { cols: this.term.cols, rows: this.term.rows, cwd: this.cwd })
    try {
      const id = await window.term.create({
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.cwd,
        tabId: this.id,
        tabName: this.name
      })
      // create 期间 tab 可能已被 dispose（此时 ptyId 还是 null，dispose 杀不到）：
      // 立刻 kill 这个新建的 PTY，否则它会变成泄漏的 ConPTY+pwsh 进程。
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
    // 调试下打印每个 chunk 的长度 + 头 N 字符预览。控制符转义后看 ANSI 序列。
    // 切 tab 出问题时拿这些 chunk 跟 setActive/refit 的时间戳比对就能定位"是不是
    // resize 期间收到错位 chunk"。
    if (typeof window !== 'undefined' && window.__termDebug) {
      dbg(this.id, `data ${data.length}B`, previewData(data))
    }
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
    // reset() 会 new 出全新的 normal/alt Buffer 实例，mount 时打在旧实例上的 reflow 遮蔽随之失效
    // （_isReflowEnabled 回落到原型 getter → conpty 下恒为 true）。必须对新实例重新遮蔽，否则
    // 切/删会话后 reflow 静默复活，之后 cc 新产出的宽表历史遇到真·改宽会再次错位。
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
    // 只在 xterm 网格真的变化时才把 resize 推给 PTY。
    // 之前无脑每次 refit 都 resize：切 tab（尺寸没变）也会给 ConPTY 一个 same-size resize，
    // 惊动 cc 重排并重发历史。ConPTY 有它自己的 reflow（在数据进 xterm 之前就做，xterm 的
    // disableReflow 管不到），把已滚上去的宽表历史行重折成 sync→sy+nc 的错位灌进 buffer ——
    // 这就是"关了 xterm reflow 仍在切 tab 时错位"的真凶。尺寸没变就不惊动 PTY；切回来由
    // setActive 的 term.refresh 从干净的 xterm buffer 重画即可。
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
    // 只在网格真的变化时才 resize PTY（改字号才会变；改主题/光标/闪烁不动网格）。
    // 否则照发一个 same-size resize 会惊动 ConPTY 自己的 reflow，把宽表历史重折成错位
    // ——与 refit() 是同一道防线。后台 tab（display:none）fit 必 no-op、更是纯 same-size。
    if (this.ptyId != null && changed) window.term.resize(this.ptyId, this.term.cols, this.term.rows)
  }

  setActive(active: boolean): void {
    dbg(this.id, `setActive(${active})`, { cols: this.term.cols, rows: this.term.rows })
    this.host.classList.toggle('active', active)
    if (!active) return
    // 调试：把当前 active 的 term 挂到 window，方便在 devtools 里深挖 buffer 状态
    // （如 __activeTerm._core._bufferService.buffers.normal._isReflowEnabled）
    ;(window as unknown as { __activeTerm?: unknown }).__activeTerm = this.term
    // display:none → block 后浏览器要 1 帧才 reflow，立刻 refit 会拿到 0 / 旧高度，
    // 算出错误 cols/rows 推给 PTY → cc 用错尺寸全屏重画 → ANSI 序列在 xterm 边界对不齐。
    // 推迟到下一帧、布局稳定后再 fit。
    requestAnimationFrame(() => {
      // 切到本 tab 后一帧内它可能已被关闭（dispose）：此时 term 已 dispose、host 已 remove，
      // 下面的 fit/refresh 虽有兜底，但 focus() 会打在已销毁的 textarea 上抛未捕获异常，直接退出。
      if (this.disposed) return
      dbg(this.id, 'setActive rAF: about to refit')
      this.refit()
      // 切回 active 时强制全量重画：display:none→block 后 xterm 不会自动重绘，
      // 若 refit 没改变 cols/rows 就不触发 resize 重画，这里兜底刷一次确保内容显示。
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
