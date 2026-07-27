import * as pty from '@lydell/node-pty'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { execSync } from 'node:child_process'
import { snapshotCurrentEnv } from './sys-env'

const IS_WIN = process.platform === 'win32'
const PWSH_PRIMARY = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function resolvePwsh(): string {
  if (existsSync(PWSH_PRIMARY)) return PWSH_PRIMARY
  try {
    const out = execSync('where.exe pwsh', { encoding: 'utf8' }).split(/\r?\n/).find(Boolean)
    if (out && existsSync(out)) return out
  } catch {}
  return 'powershell.exe'
}

// profileKey 决定注入哪份 shell-integration 脚本；null = 未知 shell，不注入（终端仍可用）。
type ProfileKey = 'pwsh' | 'zsh' | 'bash'
interface ShellInfo {
  file: string
  args: string[]
  profileKey: ProfileKey | null
}

// Windows 固定 pwsh；类 Unix（macOS）跟随用户 $SHELL，缺省 zsh。
// 用登录+交互 shell（-l -i）：macOS 下 GUI 拉起的进程 PATH 极简，必须靠登录 shell
// 走 ~/.zprofile / /etc/paths 把 node/claude 等补进 PATH。
function resolveShell(): ShellInfo {
  if (IS_WIN) return { file: resolvePwsh(), args: ['-NoLogo'], profileKey: 'pwsh' }
  const shellPath = process.env.SHELL || '/bin/zsh'
  const base = basename(shellPath).toLowerCase()
  let profileKey: ProfileKey | null = null
  if (base.includes('zsh')) profileKey = 'zsh'
  else if (base.includes('bash')) profileKey = 'bash'
  return { file: shellPath, args: ['-l', '-i'], profileKey }
}

export interface PtySession {
  id: number
  proc: pty.IPty
}

const sessions = new Map<number, PtySession>()
let nextId = 0

export interface CreateOpts {
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
  // 各平台 shell-integration 脚本路径；createPty 按 resolveShell() 选中的 shell 取用。
  profiles?: Partial<Record<ProfileKey, string>>
}

// pwsh 单引号字符串里嵌单引号：写两个单引号转义
function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// POSIX 单引号转义：'\'' 收尾一段、插一个字面单引号、再开新的一段
function quotePosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function createPty(
  opts: CreateOpts,
  onData: (id: number, data: string) => void,
  onExit: (id: number, exitCode: number) => void
): number {
  const id = nextId++
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  // Windows 兜底 USERPROFILE（不看 HOME，避免 Git Bash 等设了 HOME 时默认目录被改）；
  // 类 Unix 兜底 HOME。
  const cwd = opts.cwd || (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || process.cwd()

  // 用 snapshotCurrentEnv 而不是 process.env：Windows 上主进程 env 启动时冻结、感知不到
  // setx/注册表改动；macOS 上直接返回 process.env（登录 shell 会自行补全 PATH）。
  const env: Record<string, string> = { ...snapshotCurrentEnv(), ...(opts.env ?? {}) }

  const shellInfo = resolveShell()
  const profilePath = shellInfo.profileKey ? opts.profiles?.[shellInfo.profileKey] : undefined

  const spawnOpts: pty.IWindowsPtyForkOptions & pty.IPtyForkOptions = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  }
  // useConpty 仅 Windows 有意义；类 Unix 走系统原生 pty。
  if (IS_WIN) (spawnOpts as pty.IWindowsPtyForkOptions).useConpty = true

  const proc = pty.spawn(shellInfo.file, shellInfo.args, spawnOpts)

  if (IS_WIN) {
    // 同时把 Input/Output 编码与 console code page 都置成 UTF-8。
    // 只设 OutputEncoding 时，pwsh 提示符里粘贴含中文的路径会按 ACP=936（GBK）解码
    // 我们传进去的 UTF-8 字节流，显示成乱码。chcp 65001 + InputEncoding 一起改才彻底。
    //
    // 顺带 dot-source shell-integration.ps1：给非 cc 命令的运行态检测装钩子。
    // 必须一并塞进同一行 —— 否则用户拿到 prompt 后可能已经开始输入，profile 里覆盖
    // 的 prompt / PSConsoleHostReadLine 就晚了一步，首条命令不会发 OSC 序列。
    // profile 里的 __TERMINAL_SHELL_INTEG 防止重复加载，即便用户手动 . 也无副作用。
    const profileSuffix = profilePath ? `; . ${quoteSingle(profilePath)}` : ''
    proc.write(
      `chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8${profileSuffix}\r`
    )
  } else if (profilePath) {
    // macOS/类 Unix：UTF-8 是终端默认，不需要 chcp。只 source 一次 shell-integration
    // 脚本给非 cc 命令装运行态钩子；脚本内 __TERMINAL_SHELL_INTEG 防重复注入。
    proc.write(`. ${quotePosix(profilePath)}\n`)
  }

  proc.onData((d) => onData(id, d))
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    onExit(id, exitCode)
  })

  sessions.set(id, { id, proc })
  return id
}

export function writePty(id: number, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: number, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0))
  } catch {}
}

// 注意：曾试过在 proc.kill() 之后用 `taskkill /T /F` 杀进程树以清理孤儿子进程，
// 但在 Windows 上会把 node-pty 还在用的 ConPTY/pipe 连接突然切断，触发未捕获的
// "software caused connection abort"(WSAECONNABORTED) 导致主进程崩溃。
// 而且 ConPTY 关闭时本就会终止挂在其上的子进程，taskkill 既多余又危险，故不再使用。
export function killPty(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {}
  sessions.delete(id)
}

export function killAll(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill()
    } catch {}
  }
  sessions.clear()
}
