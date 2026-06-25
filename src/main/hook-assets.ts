import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HookPaths {
  ccHooksJson: string
  recordSessionPs1: string
  recordStatePs1: string
  eventsDir: string
  stateDir: string
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
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true })
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  const recordSessionPs1 = join(userData, 'record-session.ps1')
  const recordStatePs1 = join(userData, 'record-state.ps1')
  writeFileSync(recordSessionPs1, PS1_SESSION, 'utf8')
  writeFileSync(recordStatePs1, PS1_STATE, 'utf8')

  const stateCmd = (st: string): string =>
    `pwsh -NoProfile -File "${recordStatePs1}" ${st}`

  const settings = {
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

  return { ccHooksJson, recordSessionPs1, recordStatePs1, eventsDir, stateDir }
}
