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
  writeFileSync(sessionProbeJs, SESSION_PROBE_JS, 'utf8')
  writeFileSync(stateProbeJs, STATE_PROBE_JS, 'utf8')
  writeFileSync(statuslineJs, STATUSLINE_JS, 'utf8')

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

  return { ccHooksJson, sessionProbeJs, stateProbeJs, eventsDir, stateDir, statusDir, statuslineJs }
}
