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

// statusline 探针：cc 每 ~300ms 调一次并从 stdin 喂 JSON。用 node（pwsh 冷启动太慢扛不住此频率）
// 把会话快照按 session_id 落盘。stdout 默认留空（cc TUI 该行为空，信息都在 app 自己的底栏）；
// app 设置里打开「在终端里显示状态行」后，改为把用户自己配的 statusLine 命令跑一遍并透传其输出，
// 于是 app 内外的 cc 看到同一条状态行。
const STATUSLINE_JS = `// Claude Terminal · statusline 探针
const fs = require('fs'); const path = require('path');
const os = require('os'); const cp = require('child_process');
const dir = process.argv[2];

// 透传节流：cc 约每 300ms 调一次，而用户命令通常是 pwsh 脚本，单次一两秒。
// TTL 内直接复用上次输出，只有过期的那一次才真跑；超时上限防用户命令卡死拖垮状态行。
const PASS_TTL_MS = 3000;
const PASS_TIMEOUT_MS = 5000;

// app 自己的设置（<userData>/settings.json，dir 是它下面的 session-status）
function appSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'settings.json'), 'utf8'));
  } catch (e) { return null; }
}

// 用户自己的 statusLine 命令：按 cc 的配置优先级找第一个有 statusLine 的，
// 项目级 local → 项目级 → 用户级。app 传的 --settings 优先级最高，正是它把这条挡掉的。
function userStatusLineCmd(cwd) {
  const files = [];
  if (cwd) {
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
    files.push(path.join(cwd, '.claude', 'settings.json'));
  }
  files.push(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'));
  for (let i = 0; i < files.length; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(files[i], 'utf8'));
      const sl = j && j.statusLine;
      if (sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) {
        const c = sl.command.trim();
        // 自引用保护：配置指回本探针会无限套娃
        if (c.indexOf('statusline-probe') >= 0) return '';
        return c;
      }
    } catch (e) {}
  }
  return '';
}

// Windows: cc 用类 unix shell 跑 statusLine，用户往往配成正斜杠路径，
// 而这里走 cmd.exe，正斜杠会被当成开关。整条就是一个存在的文件路径时换成反斜杠。
function shellReady(cmd) {
  if (process.platform !== 'win32') return cmd;
  const bare = cmd.replace(/^"([^"]*)"$/, '$1');
  if (bare.indexOf('/') < 0) return cmd;
  if (/[&|<>^]/.test(bare)) return cmd;
  const win = bare.replace(/\\//g, '\\\\');
  try { if (fs.existsSync(win)) return '"' + win + '"'; } catch (e) {}
  return cmd;
}

// 跑用户命令，把 cc 给我们的原始 stdin 原样转喂。失败/超时返回 null 由调用方退回旧缓存。
function runUserCmd(cmd, input, cb) {
  let settled = false;
  let out = '';
  const finish = (v) => { if (settled) return; settled = true; cb(v); };
  let child;
  try {
    child = cp.spawn(shellReady(cmd), { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) { return finish(null); }
  const timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish(null); }, PASS_TIMEOUT_MS);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.on('error', () => { clearTimeout(timer); finish(null); });
  child.on('close', () => { clearTimeout(timer); finish(out); });
  try { child.stdin.write(input); child.stdin.end(); } catch (e) {}
}

function passthrough(j) {
  const s = appSettings();
  if (!s || s.showStatusLine !== true) return;
  const ws = j && j.workspace;
  const cwd = (ws && (ws.current_dir || ws.project_dir)) || (j && j.cwd) || '';
  const cmd = userStatusLineCmd(cwd);
  if (!cmd) return;
  const sid = (j && j.session_id) || 'default';
  const cacheFile = path.join(dir, '_statusline-' + sid + '.txt');
  const lockFile = cacheFile + '.lock';
  let cached = '';
  let age = Infinity;
  try {
    cached = fs.readFileSync(cacheFile, 'utf8');
    age = Date.now() - fs.statSync(cacheFile).mtimeMs;
  } catch (e) {}
  if (age < PASS_TTL_MS) { process.stdout.write(cached); return; }
  // 上一次刷新还没跑完 → 本次只吐旧内容，不再叠一个进程
  try {
    if (Date.now() - fs.statSync(lockFile).mtimeMs < PASS_TIMEOUT_MS) { process.stdout.write(cached); return; }
  } catch (e) {}
  try { fs.writeFileSync(lockFile, String(process.pid)); } catch (e) {}
  runUserCmd(cmd, raw, (out) => {
    try { fs.unlinkSync(lockFile); } catch (e) {}
    if (out == null) { process.stdout.write(cached); return; }
    const text = out.replace(/\\s+$/, '');
    try { fs.writeFileSync(cacheFile, text); } catch (e) {}
    process.stdout.write(text);
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {}
  try { snapshot(parsed); } catch (e) {}
  // 落盘失败不该连累状态行，反之亦然 → 两段各自 try
  try { passthrough(parsed); } catch (e) {}
});

function snapshot(j) {
  {
    if (!j) return;
    const sid = j.session_id; if (!sid || !dir) return;
    const cw = j.context_window || {};
    const cu = cw.current_usage || {};
    const tokens = (cu.input_tokens||0) + (cu.cache_creation_input_tokens||0) + (cu.cache_read_input_tokens||0);
    let pct = cw.used_percentage;
    if (typeof pct !== 'number' || pct <= 0) {
      const sz = cw.context_window_size || 0;
      pct = sz > 0 ? Math.round(tokens / sz * 100) : 0;
    }
    const raw_id = (j.model && j.model.id) || '';
    const raw_label = (j.model && (j.model.display_name || j.model.id)) || '';
    const out = {
      sessionId: sid,
      modelId: String(raw_id).trim(),
      modelLabel: String(raw_label).replace(/\\s*\\([^)]*context[^)]*\\)/i, '').trim(),
      // 旧版 statusline 字段保留，方便旧读取器和已有状态文件平滑过渡。
      model: String(raw_label).replace(/\\s*\\([^)]*context[^)]*\\)/i, '').trim(),
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
  }
}
`

// 解析 node 绝对路径（cc 的 statusline shell 不一定有 PATH）；
// macOS GUI 进程 PATH 极简，需借登录+交互 shell 解析。
function detectNodePath(): string {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (out[0]) return out[0]
    } catch {}
    return 'node'
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const lines = execFileSync(shell, ['-lic', 'command -v node'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    // 交互 shell 可能先吐别的内容 → 从末尾找绝对路径行
    const line = lines.reverse().find((l) => l.startsWith('/'))
    if (line) return line
  } catch {}
  return 'node'
}

// SessionStart hook（node）。必须用 node 而非 pwsh：PS 冷启动慢 + 并发 IO 异常会导致
// 非零退出、jsonl 丢行。出错路径全部 swallow + 始终 exit 0，hook 失败不影响 cc 主流程。
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

// 状态 hook（node）：state 走 argv[3]，dir 走 argv[2]；先写 .tmp 再 rename 避免 watcher 读到半截 JSON。
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
    let msg = null; let errorKind = null;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.message === 'string') msg = j.message;
        // StopFailure 不带 message：错误文案在 last_assistant_message，错误分类在 error
        else if (j && typeof j.last_assistant_message === 'string') msg = j.last_assistant_message;
        if (j && typeof j.error === 'string') errorKind = j.error;
      } catch (e) {}
    }
    const obj = { state: state, message: msg, errorKind: errorKind, ts: new Date().toISOString() };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const out = path.join(dir, tab + '.json');
    const tmp = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, out);
  } catch (e) {}
});
`

// pwsh shell-integration：仿 VS Code 输出 OSC 133;A/B/C/D 与 633;E，渲染层据此做非 cc 命令的
// 运行态检测（cc 状态仍由 hooks 主导）。[Console]::Write 直写绕开 pwsh buffering；不改用户 profile。
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
    # app 设置里开了「默认危险模式」→ pty:create 注入 TERMINAL_CC_DANGEROUS=1
    if ($env:TERMINAL_CC_DANGEROUS -eq '1') { $settingsArg += '--dangerously-skip-permissions' }
    if ($isResume) {
        & $claudeBin @settingsArg --resume @passArgs
    } else {
        $sid = [guid]::NewGuid().ToString()
        $name = if ($env:TERMINAL_TAB_NAME) { $env:TERMINAL_TAB_NAME } else { 'cct' }
        & $claudeBin @settingsArg --session-id $sid --name $name @passArgs
    }
}
`

// cct（POSIX 版，zsh/bash 通用）：手动启动可被 app 接管的 cc 会话，语义与 pwsh 版一致。
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
  # app 设置里开了「默认危险模式」→ pty:create 注入 TERMINAL_CC_DANGEROUS=1
  local danger=()
  [ "$TERMINAL_CC_DANGEROUS" = "1" ] && danger=(--dangerously-skip-permissions)
  if [ "$is_resume" -eq 1 ]; then
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" "\${danger[@]}" --resume "\${pass[@]}"
  else
    local sid
    sid=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')
    [ -z "$sid" ] && sid=$(node -e 'console.log(require("crypto").randomUUID())' 2>/dev/null)
    local name=\${TERMINAL_TAB_NAME:-cct}
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" "\${danger[@]}" --session-id "$sid" --name "$name" "\${pass[@]}"
  fi
}
`

// zsh shell-integration：preexec/precmd hook 发同一套 OSC 序列；__TERMINAL_SHELL_INTEG 防重复注入。
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

// bash shell-integration：无内建 preexec/precmd，用 DEBUG trap + PROMPT_COMMAND 近似（best-effort）。
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
      // 本轮因 API 错误结束 → 红点。这是判定 API 出错的唯一可靠信号：cc 内部重试
      // （实测最多 10 次、可长达 3 分钟）全程不发任何 hook，重试成功也不会发本事件，
      // 所以挂上它之后，重试中间态不再被误判成错误（那是 terminal-tab 扫文本的老毛病）。
      // stdin 带 error（错误分类）与 last_assistant_message（错误文案），state-probe 都取走。
      StopFailure: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('error') }] }
      ],
      PostToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('busy') }] }
      ],
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: stateCmd('attention') }] },
        { matcher: 'elicitation_dialog', hooks: [{ type: 'command', command: stateCmd('attention') }] }
        // 不挂 idle_prompt：它会把绿点（done）静默盖回灰点；idle 只由 renderer 降级倒计时产生
      ]
    }
  }
  const ccHooksJson = join(userData, 'cc-hooks.json')
  writeFileSync(ccHooksJson, JSON.stringify(settings, null, 2), 'utf8')

  return { ccHooksJson, sessionProbeJs, stateProbeJs, eventsDir, stateDir, statusDir, statuslineJs, pwshProfilePs1, zshProfile, bashProfile }
}
