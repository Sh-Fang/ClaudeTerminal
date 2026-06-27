import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface HookPaths {
  ccHooksJson: string
  recordSessionPs1: string
  recordStatePs1: string
  eventsDir: string
  stateDir: string
  statusDir: string
  statuslineJs: string
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

const PS1_SESSION = `# Claude Terminal · SessionStart hook
$ErrorActionPreference='SilentlyContinue'
$tab = $env:TERMINAL_TAB_ID
if (-not $tab) { exit 0 }
$dir = $env:TERMINAL_EVENTS_DIR
if (-not $dir) { exit 0 }
try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
  $in = $raw | ConvertFrom-Json
} catch { exit 0 }
$out = Join-Path $dir ($tab + '.jsonl')
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$row = @{
  sessionId = $in.session_id
  cwd       = $in.cwd
  source    = $in.source
  ts        = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress
Add-Content -Encoding utf8 -Path $out -Value $row
exit 0
`

// 状态 hook：state 来自 args[0]，message 取 stdin payload 的 .message 字段
const PS1_STATE = `# Claude Terminal · 状态 hook
$ErrorActionPreference='SilentlyContinue'
$tab = $env:TERMINAL_TAB_ID
if (-not $tab) { exit 0 }
$dir = $env:TERMINAL_STATE_DIR
if (-not $dir) { exit 0 }
$state = if ($args.Length -gt 0) { $args[0] } else { 'idle' }
$msg = $null
try {
  $raw = [Console]::In.ReadToEnd()
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $in = $raw | ConvertFrom-Json
    if ($in -and $in.message) { $msg = [string]$in.message }
  }
} catch {}
$out = Join-Path $dir ($tab + '.json')
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$obj = @{ state = $state; message = $msg; ts = (Get-Date).ToString('o') }
$tmp = $out + '.tmp'
$obj | ConvertTo-Json -Compress | Set-Content -Encoding utf8 -Path $tmp
Move-Item -Force -Path $tmp -Destination $out
exit 0
`

export function ensureHookAssets(): HookPaths {
  const userData = app.getPath('userData')
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })

  const eventsDir = join(userData, 'session-events')
  const stateDir = join(userData, 'session-state')
  const statusDir = join(userData, 'session-status')
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true })
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  if (!existsSync(statusDir)) mkdirSync(statusDir, { recursive: true })

  const recordSessionPs1 = join(userData, 'record-session.ps1')
  const recordStatePs1 = join(userData, 'record-state.ps1')
  const statuslineJs = join(userData, 'statusline-probe.cjs')
  writeFileSync(recordSessionPs1, PS1_SESSION, 'utf8')
  writeFileSync(recordStatePs1, PS1_STATE, 'utf8')
  writeFileSync(statuslineJs, STATUSLINE_JS, 'utf8')

  const stateCmd = (st: string): string =>
    `pwsh -NoProfile -File "${recordStatePs1}" ${st}`

  // 经 sh 执行，Windows 路径在双引号里原样传给 node（与 hooks 同款写法）
  const statuslineCmd = `"${detectNodePath()}" "${statuslineJs}" "${statusDir}"`

  const settings = {
    statusLine: { type: 'command', command: statuslineCmd },
    hooks: {
      SessionStart: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `pwsh -NoProfile -File "${recordSessionPs1}"` }]
        }
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
        { matcher: 'elicitation_dialog', hooks: [{ type: 'command', command: stateCmd('attention') }] },
        { matcher: 'idle_prompt', hooks: [{ type: 'command', command: stateCmd('idle') }] }
      ]
    }
  }
  const ccHooksJson = join(userData, 'cc-hooks.json')
  writeFileSync(ccHooksJson, JSON.stringify(settings, null, 2), 'utf8')

  return { ccHooksJson, recordSessionPs1, recordStatePs1, eventsDir, stateDir, statusDir, statuslineJs }
}
