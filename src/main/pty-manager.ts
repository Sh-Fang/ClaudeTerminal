import * as pty from '@lydell/node-pty'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const PWSH_PRIMARY = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function resolvePwsh(): string {
  if (existsSync(PWSH_PRIMARY)) return PWSH_PRIMARY
  try {
    const out = execSync('where.exe pwsh', { encoding: 'utf8' }).split(/\r?\n/).find(Boolean)
    if (out && existsSync(out)) return out
  } catch {}
  return 'powershell.exe'
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
}

export function createPty(
  opts: CreateOpts,
  onData: (id: number, data: string) => void,
  onExit: (id: number, exitCode: number) => void
): number {
  const id = nextId++
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  const cwd = opts.cwd || process.env.USERPROFILE || process.cwd()

  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) }

  const proc = pty.spawn(resolvePwsh(), ['-NoLogo'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: true
  })

  proc.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r')

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
