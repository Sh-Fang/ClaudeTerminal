import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  watch,
  openSync,
  readSync,
  closeSync,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import { UUID_RE } from './claude-paths'
import { isSessionSource } from './session-constants'
import { resolveTabWc } from './tab-router'

interface FileState {
  offset: number
  debounce: NodeJS.Timeout | null
}

// 从文件按字节区间 [start, end) 读出，再 utf8 解码。
// 关键：offset/size 来自 statSync().size，是「字节」偏移；hook 每次 append 整行
// （行尾是 ASCII 换行），故区间端点必落在字符边界上，按字节切是安全的。
// 切勿先 readFile('utf8') 再用字节下标 slice 字符串——含中文 cwd 时字节数>字符数，
// offset 会逐渐漂移，导致新会话事件被静默丢弃。
function readByteRange(path: string, start: number, end: number): string {
  const len = end - start
  if (len <= 0) return ''
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, start)
    return buf.toString('utf8', 0, n)
  } catch {
    return ''
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
}

export class SessionEventWatcher {
  private dir: string
  private files = new Map<string, FileState>()
  private watcher: FSWatcher | null = null

  // 多窗口：事件按 tabId 路由到承载窗口（tab-router 解析，找不到兜底主窗口）
  constructor(dir: string) {
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

    const chunk = readByteRange(full, start, size)
    if (!chunk) return
    const tabId = name.slice(0, -'.jsonl'.length)
    const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0)
    for (const line of lines) this.parseAndEmit(tabId, line)
  }

  private parseAndEmit(tabId: string, line: string): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch { return }
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : ''
    if (!UUID_RE.test(sessionId)) return
    const source = isSessionSource(obj.source) ? obj.source : 'startup'
    const payload = {
      tabId,
      sessionId,
      source,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      ts: typeof obj.ts === 'string' ? obj.ts : undefined
    }
    const wc = resolveTabWc(tabId)
    if (!wc) return
    try { wc.send('session:event', payload) } catch {}
  }
}
