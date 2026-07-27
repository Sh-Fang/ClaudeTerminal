import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface HookPaths {
  ccHooksJson: string
  sessionProbeJs: string
  stateProbeJs: string
  eventsDir: string
  stateDir: string
  statusDir: string
  statuslineJs: string
  pwshProfilePs1: string  // Windows: pwsh shell-integration
  zshProfile: string      // macOS: zsh shell-integration
  bashProfile: string     // macOS: bash shell-integration
}

// cc 每 ~300ms 调一次 statusLine 命令并从 stdin 喂 JSON（含 context_window / model）。
// 用 node（启动快，pwsh 太慢扛不住这个频率）读 stdin、把会话快照按 session_id 落盘，
// stdout 输出空串 → cc TUI 那行留空。数据由 app 底部状态栏展示。
const STATUSLINE_JS = `// Claude Terminal · statusline 探针
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw);
    const sid = j.session_id; if (!sid || !dir) return;
    const cw = j.context_window || {};
    const cu = cw.current_usage || {};
    const tokens = (cu.input_tokens||0) + (cu.cache_creation_input_tokens||0) + (cu.cache_read_input_tokens||0);
    let pct = cw.used_percentage;
    if (typeof pct !== 'number' || pct <= 0) {
      const sz = cw.context_window_size || 0;
      pct = sz > 0 ? Math.round(tokens / sz * 100) : 0;
    }
    const raw_model = (j.model && (j.model.display_name || j.model.id)) || '';
    const out = {
      sessionId: sid,
      model: String(raw_model).replace(/\\s*\\([^)]*context[^)]*\\)/i, '').trim(),
      // 当前思考强度（low/medium/high/xhigh/max）。cc 仅在模型支持 effort 时给该字段，
      // 不支持时为空串 → 渲染层据此隐藏 effort 芯片。
      effort: (j.effort && j.effort.level) || '',
      window: cw.context_window_size || 0,
      percent: Math.min(100, Math.max(0, Math.round(pct || 0))),
      tokens: tokens,
      savedAt: Date.now()
    };
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, sid + '.json'); const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, f);

    // 账号用量（5h/周）：cc 已联网把 rate_limits 放进 stdin → 不需要我们再调 API、不依赖代理
    const rl = j.rate_limits;
    if (rl) {
      const win = (w) => {
        if (!w || typeof w.used_percentage !== 'number') return null;
        let resetsAt = null;
        if (typeof w.resets_at === 'number' && w.resets_at > 0) {
          const ms = w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000;
          resetsAt = new Date(ms).toISOString();
        } else if (typeof w.resets_at === 'string' && w.resets_at) {
          resetsAt = w.resets_at;
        }
        return { percent: Math.min(100, Math.max(0, Math.round(w.used_percentage))), resetsAt: resetsAt };
      };
      const fh = win(rl.five_hour); const sd = win(rl.seven_day);
      if (fh || sd) {
        const acct = { fiveHour: fh, sevenDay: sd, savedAt: Date.now() };
        const af = path.join(dir, '_account-usage.json'); const atmp = af + '.' + process.pid + '.tmp';
        fs.writeFileSync(atmp, JSON.stringify(acct)); fs.renameSync(atmp, af);
      }
    }
  } catch (e) {}
  // 不输出任何内容 → cc 的 statusline 行留空
});
`

// 解析 node 可执行路径（cc 的 statusline shell 不一定有 PATH，尽量用绝对路径）
function detectNodePath(): string {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (out[0]) return out[0]
    } catch {
      // 退回 PATH
    }
    return 'node'
  }
  // macOS/类 Unix：GUI 拉起的主进程 PATH 极简（拿不到 nvm/homebrew 的 node）。
  // 用登录+交互 shell 解析真实 node 绝对路径；-i 让 ~/.zshrc 里的 PATH 也生效。
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const lines = execFileSync(shell, ['-lic', 'command -v node'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    // 交互 shell 可能先吐别的内容 → 从末尾找第一条绝对路径行
    const line = lines.reverse().find((l) => l.startsWith('/'))
    if (line) return line
  } catch {
    // 退回 PATH
  }
  return 'node'
}

// SessionStart hook（node）。原来用 pwsh，cc 偶尔报 "SessionStart:resume hook error / Failed
// with non-blocking status code: No stderr output" —— 推测是 PS 冷启动慢 + Add-Content 在并发
// IO 下抛了非终止异常 + $ErrorActionPreference 兜不住 → 非零退出 → cc 当 hook 失败 → .jsonl
// 那行根本没写出去 → watcher 拿不到 → 渲染层栈不更新（"resume 后栈里没新会话"）。
// 换 node：启动快、stdin 读法稳、appendFileSync 走 OS 原生 append 不会被 PS 那套 shareMode 卡。
// 出错路径全部 swallow + 始终 exit 0 —— hook 失败不影响 cc 主流程。
// dir 走 argv[2] 而不是 env：减少 1 条 env 依赖，少一个漂移点。
const SESSION_PROBE_JS = `// Claude Terminal · SessionStart hook
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const tab = process.env.TERMINAL_TAB_ID || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try {
    if (!dir || !tab) return;
    if (!raw) return;
    const j = JSON.parse(raw);
    const sid = (j && j.session_id) || '';
    if (!sid) return;
    const row = {
      sessionId: sid,
      cwd: (j && j.cwd) || '',
      source: (j && j.source) || 'startup',
      ts: new Date().toISOString()
    };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.appendFileSync(path.join(dir, tab + '.jsonl'), JSON.stringify(row) + '\\n', 'utf8');
  } catch (e) {}
});
`

// 状态 hook（node）。state 走 argv[3]（busy/done/attention/idle），dir 走 argv[2]。
// 原子写：先写 .tmp 再 rename，避免 watcher 读到半截 JSON。
const STATE_PROBE_JS = `// Claude Terminal · 状态 hook
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const state = process.argv[3] || 'idle';
const tab = process.env.TERMINAL_TAB_ID || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try {
    if (!dir || !tab) return;
    let msg = null;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.message === 'string') msg = j.message;
      } catch (e) {}
    }
    const obj = { state: state, message: msg, ts: new Date().toISOString() };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const out = path.join(dir, tab + '.json');
    const tmp = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, out);
  } catch (e) {}
});
`

// pwsh shell-integration profile：给非 cc 命令做「运行态」检测。
// 借鉴 VS Code 的 shell integration，输出 OSC 133;A/B/C/D 和 OSC 633;E 序列。
// renderer 侧用 xterm parser.registerOscHandler 接住:
//   E;<cmd> → 记下即将执行的命令行（用于过滤是不是 cc）
//   C       → 标记 shell-busy=true（蓝点）
//   A / D   → 回到 prompt，shell-busy=false（灰点）
// 只对 autoLaunchCC=false 的 tab 生效；cc 的状态仍由 hooks 主导，避免重复标注。
// 用 [Console]::Write 直写 stdout，绕开 pwsh 输出流的 buffering，保证 OSC 立即到达 PTY。
// 复用 pwsh 内建的 $function:prompt 和 PSReadLine 的 AddToHistoryHandler / PSConsoleHostReadLine，
// 不改写用户已有的 profile，只在会话内追加钩子；env 变量 __TERMINAL_SHELL_INTEG 防止重复注入。
const PWSH_PROFILE_PS1 = `# Claude Terminal · pwsh shell integration
if ($env:__TERMINAL_SHELL_INTEG -ne '1') {
    $env:__TERMINAL_SHELL_INTEG = '1'
    $Global:__TerminalInFlight = $false

    # 保留原 prompt，包一层：命令结束(D) + 提示开始(A) + 提示结束(B)
    $Global:__TerminalOrigPrompt = $function:prompt
    function Global:prompt {
        $code = 0
        if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
        elseif (-not $?) { $code = 1 }
        if ($Global:__TerminalInFlight) {
            [Console]::Write("\`e]133;D;$code\`a")
            $Global:__TerminalInFlight = $false
        }
        [Console]::Write("\`e]133;A\`a")
        $out = & $Global:__TerminalOrigPrompt
        [Console]::Write("\`e]133;B\`a")
        return $out
    }

    # 命令开始(C) + 命令行(E) 通过 PSReadLine 的 AddToHistoryHandler 触发。
    # 该 handler 在用户按 Enter、命令进入 history 时被调用，正好在命令实际执行之前。
    # \`n / \`r / ESC 都要清掉，避免破坏 OSC 序列或把控制符注入进 renderer 的 parser。
    # 用 $Global: 保存原 handler：ScriptBlock 默认按运行时 scope 查变量，脚本退出后
    # 局部 $prev 就没了；套 Global 保证 handler 每次调用都能取到。
    try {
        $Global:__TerminalPrevAddHistory = (Get-PSReadLineOption).AddToHistoryHandler
        Set-PSReadLineOption -AddToHistoryHandler {
            param([string]$line)
            if ($line) {
                $esc = $line -replace "\`e", '' -replace "\`n", ' ' -replace "\`r", ''
                [Console]::Write("\`e]633;E;$esc\`a")
                [Console]::Write("\`e]133;C\`a")
                $Global:__TerminalInFlight = $true
            }
            if ($null -ne $Global:__TerminalPrevAddHistory) {
                return & $Global:__TerminalPrevAddHistory $line
            }
            return $true
        }
    } catch {}
}

# cct: 手动启动一次能被 app 接管的 cc 会话。
# - 复用 pty:create 时注入的 env：
#   TERMINAL_TAB_ID / TERMINAL_HOOK_SETTINGS_JSON / TERMINAL_CLAUDE_PATH / TERMINAL_TAB_NAME
# - 无参 → --session-id <新 uuid> --name <tab>：新会话，hook 上报后 app 压栈
# - -r / --resume → --resume：cc 自己弹选择器让用户选历史会话
# - 其余参数原样透传给 claude（可 cct --model xxx 等）
function Global:cct {
    if (-not $env:TERMINAL_TAB_ID) {
        Write-Host "cct: 需要在 Claude Terminal 的 tab 里运行" -ForegroundColor Yellow
        return
    }
    if (-not $env:TERMINAL_HOOK_SETTINGS_JSON -or -not (Test-Path $env:TERMINAL_HOOK_SETTINGS_JSON)) {
        Write-Host "cct: 缺少 cc-hooks.json (TERMINAL_HOOK_SETTINGS_JSON)" -ForegroundColor Red
        return
    }
    $isResume = $false
    $passArgs = @()
    foreach ($a in $args) {
        if ($a -eq '-r' -or $a -eq '--resume') { $isResume = $true; continue }
        $passArgs += $a
    }
    $claudeBin = if ($env:TERMINAL_CLAUDE_PATH) { $env:TERMINAL_CLAUDE_PATH } else { 'claude' }
    $settingsArg = @('--settings', $env:TERMINAL_HOOK_SETTINGS_JSON)
    if ($isResume) {
        & $claudeBin @settingsArg --resume @passArgs
    } else {
        $sid = [guid]::NewGuid().ToString()
        $name = if ($env:TERMINAL_TAB_NAME) { $env:TERMINAL_TAB_NAME } else { 'cct' }
        & $claudeBin @settingsArg --session-id $sid --name $name @passArgs
    }
}
`

// cct（POSIX 函数，zsh / bash 通用）：手动启动一次能被 app 接管的 cc 会话。
// 与 pwsh 版语义一致：复用 pty:create 注入的 TERMINAL_* env；无参 = 新会话
// （--session-id 新 uuid --name <tab>），-r/--resume = cc 自己弹历史选择器。
const CCT_SH = `cct() {
  if [ -z "$TERMINAL_TAB_ID" ]; then
    printf '%s\\n' "cct: 需要在 Claude Terminal 的 tab 里运行"; return 1
  fi
  if [ -z "$TERMINAL_HOOK_SETTINGS_JSON" ] || [ ! -f "$TERMINAL_HOOK_SETTINGS_JSON" ]; then
    printf '%s\\n' "cct: 缺少 cc-hooks.json (TERMINAL_HOOK_SETTINGS_JSON)"; return 1
  fi
  local is_resume=0
  local pass=()
  local a
  for a in "$@"; do
    if [ "$a" = "-r" ] || [ "$a" = "--resume" ]; then is_resume=1; continue; fi
    pass+=("$a")
  done
  local claude_bin=\${TERMINAL_CLAUDE_PATH:-claude}
  if [ "$is_resume" -eq 1 ]; then
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" --resume "\${pass[@]}"
  else
    local sid
    sid=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')
    [ -z "$sid" ] && sid=$(node -e 'console.log(require("crypto").randomUUID())' 2>/dev/null)
    local name=\${TERMINAL_TAB_NAME:-cct}
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" --session-id "$sid" --name "$name" "\${pass[@]}"
  fi
}
`

// zsh shell-integration：给非 cc 命令做「运行态」检测（对齐渲染层消费的 OSC 子集）。
//   preexec → 发 OSC 633;E;<cmd>（命令行原文，供过滤 cc）+ OSC 133;C（命令开始=busy）
//   precmd  → 命令结束发 OSC 133;D;<code>，再发 133;A（回到 prompt=idle）
// 用 zsh 内建 preexec/precmd hook；__terminal_osc 把 ESC/BEL 收敛到一处，减少转义面。
// __TERMINAL_SHELL_INTEG 防重复注入（export 后子 shell 也不会重复挂）。
const ZSH_PROFILE = `# Claude Terminal · zsh shell integration
if [ -z "$__TERMINAL_SHELL_INTEG" ]; then
  export __TERMINAL_SHELL_INTEG=1
  typeset -g __terminal_in_flight=0
  __terminal_osc() { printf '\\033]%s\\007' "$1"; }
  __terminal_preexec() {
    local cmd=\${1//[$'\\n\\r']/ }
    __terminal_osc "633;E;$cmd"
    __terminal_osc "133;C"
    __terminal_in_flight=1
  }
  __terminal_precmd() {
    local code=$?
    if (( __terminal_in_flight )); then
      __terminal_osc "133;D;$code"
      __terminal_in_flight=0
    fi
    __terminal_osc "133;A"
  }
  autoload -Uz add-zsh-hook 2>/dev/null
  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook preexec __terminal_preexec
    add-zsh-hook precmd __terminal_precmd
  else
    preexec_functions+=(__terminal_preexec)
    precmd_functions+=(__terminal_precmd)
  fi
fi

${CCT_SH}`

// bash shell-integration：bash 无内建 preexec/precmd，用 DEBUG trap 近似 preexec、
// PROMPT_COMMAND 近似 precmd（bash-preexec 的精简版，best-effort）。
//   DEBUG trap：每条命令执行前触发，__terminal_preexec_done 保证一条命令只发一次
//   PROMPT_COMMAND：先跑用户原有的，再发命令结束/回到 prompt 序列
const BASH_PROFILE = `# Claude Terminal · bash shell integration (best-effort)
if [ -z "$__TERMINAL_SHELL_INTEG" ] && [[ "$-" == *i* ]]; then
  export __TERMINAL_SHELL_INTEG=1
  __terminal_in_flight=0
  __terminal_preexec_done=0
  __terminal_osc() { printf '\\033]%s\\007' "$1"; }
  __terminal_preexec() {
    __terminal_osc "633;E;$1"
    __terminal_osc "133;C"
    __terminal_in_flight=1
  }
  __terminal_precmd() {
    local code=$1
    if (( __terminal_in_flight )); then
      __terminal_osc "133;D;$code"
      __terminal_in_flight=0
    fi
    __terminal_osc "133;A"
    __terminal_preexec_done=0
  }
  __terminal_debug() {
    [[ "$BASH_COMMAND" == "__terminal_prompt_cmd" ]] && return
    (( __terminal_preexec_done )) && return
    __terminal_preexec_done=1
    __terminal_preexec "$BASH_COMMAND"
  }
  __terminal_orig_pc="$PROMPT_COMMAND"
  __terminal_prompt_cmd() {
    local ec=$?
    if [ -n "$__terminal_orig_pc" ]; then eval "$__terminal_orig_pc"; fi
    __terminal_precmd "$ec"
  }
  PROMPT_COMMAND=__terminal_prompt_cmd
  trap '__terminal_debug' DEBUG
fi

${CCT_SH}`

export function ensureHookAssets(): HookPaths {
  const userData = app.getPath('userData')
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })

  const eventsDir = join(userData, 'session-events')
  const stateDir = join(userData, 'session-state')
  const statusDir = join(userData, 'session-status')
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true })
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  if (!existsSync(statusDir)) mkdirSync(statusDir, { recursive: true })

  const sessionProbeJs = join(userData, 'session-probe.cjs')
  const stateProbeJs = join(userData, 'state-probe.cjs')
  const statuslineJs = join(userData, 'statusline-probe.cjs')
  const pwshProfilePs1 = join(userData, 'shell-integration.ps1')
  const zshProfile = join(userData, 'shell-integration.zsh')
  const bashProfile = join(userData, 'shell-integration.bash')
  writeFileSync(sessionProbeJs, SESSION_PROBE_JS, 'utf8')
  writeFileSync(stateProbeJs, STATE_PROBE_JS, 'utf8')
  writeFileSync(statuslineJs, STATUSLINE_JS, 'utf8')
  writeFileSync(pwshProfilePs1, PWSH_PROFILE_PS1, 'utf8')
  writeFileSync(zshProfile, ZSH_PROFILE, 'utf8')
  writeFileSync(bashProfile, BASH_PROFILE, 'utf8')

  const nodePath = detectNodePath()
  const sessionCmd = `"${nodePath}" "${sessionProbeJs}" "${eventsDir}"`
  const stateCmd = (st: string): string =>
    `"${nodePath}" "${stateProbeJs}" "${stateDir}" ${st}`
  const statuslineCmd = `"${nodePath}" "${statuslineJs}" "${statusDir}"`

  const settings = {
    statusLine: { type: 'command', command: statuslineCmd },
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: sessionCmd }] }
      ],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('busy') }] }
      ],
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('done') }] }
      ],
      PostToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('busy') }] }
      ],
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: stateCmd('attention') }] },
        { matcher: 'elicitation_dialog', hooks: [{ type: 'command', command: stateCmd('attention') }] }
        // 不挂 idle_prompt：cc Stop 后 ~60s 没人理就发 idle_prompt，若映射成 idle 会把
        // 绿点（done）静默盖回灰点（idle），表现为"明明完成了但没绿点"。
        // idle 只该由 renderer 的降级倒计时产生（用户切到 done tab 看过后才降）。
      ]
    }
  }
  const ccHooksJson = join(userData, 'cc-hooks.json')
  writeFileSync(ccHooksJson, JSON.stringify(settings, null, 2), 'utf8')

  return { ccHooksJson, sessionProbeJs, stateProbeJs, eventsDir, stateDir, statusDir, statuslineJs, pwshProfilePs1, zshProfile, bashProfile }
}
