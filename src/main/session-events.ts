import type { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, watch, readFile, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

interface FileState {
  offset: number
  debounce: NodeJS.Timeout | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_SOURCES = new Set(['startup', 'clear', 'compact', 'resume'])

export class SessionEventWatcher {
  private dir: string
  private files = new Map<string, FileState>()
  private watcher: FSWatcher | null = null

  constructor(dir: string, private getWindow: () => BrowserWindow | null) {
    this.dir = dir
  }

  start(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })

    // 初始化已有文件的 offset 为当前长度，只关心从现在开始的新事件
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const sz = statSync(join(this.dir, name)).size
        this.files.set(name, { offset: sz, debounce: null })
      } catch {}
    }

    this.watcher = watch(this.dir, { persistent: false }, (_evt, filename) => {
      if (!filename) return
      const name = String(filename)
      if (!name.endsWith('.jsonl')) return
      this.scheduleRead(name)
    })
  }

  stop(): void {
    try { this.watcher?.close() } catch {}
    this.watcher = null
    for (const s of this.files.values()) if (s.debounce) clearTimeout(s.debounce)
    this.files.clear()
  }

  private scheduleRead(name: string): void {
    let st = this.files.get(name)
    if (!st) {
      st = { offset: 0, debounce: null }
      this.files.set(name, st)
    }
    if (st.debounce) clearTimeout(st.debounce)
    st.debounce = setTimeout(() => this.drain(name), 60)
  }

  private drain(name: string): void {
    const state = this.files.get(name)
    if (!state) return
    state.debounce = null
    const full = join(this.dir, name)
    let size: number
    try { size = statSync(full).size } catch { return }
    if (size <= state.offset) {
      // 文件可能被截短/重建：从头读
      if (size < state.offset) state.offset = 0
      else return
    }
    const start = state.offset
    state.offset = size

    readFile(full, { encoding: 'utf8' }, (err, raw) => {
      if (err) return
      const chunk = raw.slice(start, size)
      const tabId = name.slice(0, -'.jsonl'.length)
      const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0)
      for (const line of lines) this.parseAndEmit(tabId, line)
    })
  }

  private parseAndEmit(tabId: string, line: string): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch { return }
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : ''
    if (!UUID_RE.test(sessionId)) return
    const sourceRaw = typeof obj.source === 'string' ? obj.source : 'startup'
    const source = ALLOWED_SOURCES.has(sourceRaw) ? sourceRaw : 'startup'
    const payload = {
      tabId,
      sessionId,
      source,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      ts: typeof obj.ts === 'string' ? obj.ts : undefined
    }
    const w = this.getWindow()
    if (!w || w.isDestroyed()) return
    const wc = w.webContents
    if (!wc || wc.isDestroyed()) return
    try { wc.send('session:event', payload) } catch {}
  }
}
