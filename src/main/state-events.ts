import { existsSync, mkdirSync, readdirSync, readFile, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { isTabStatus } from './session-constants'
import { resolveTabWc } from './tab-router'

interface FileState {
  debounce: NodeJS.Timeout | null
  lastJson: string
}

export class StateEventWatcher {
  private files = new Map<string, FileState>()
  private watcher: FSWatcher | null = null

  // 多窗口：事件按 tabId 路由到承载窗口（tab-router 解析，找不到兜底主窗口）
  constructor(private dir: string) {}

  start(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    // 启动时不补发已有状态，避免覆盖 renderer 内存中的更准状态
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith('.json')) this.files.set(name, { debounce: null, lastJson: '' })
    }
    this.watcher = watch(this.dir, { persistent: false }, (_evt, filename) => {
      if (!filename) return
      const name = String(filename)
      if (!name.endsWith('.json')) return
      this.schedule(name)
    })
  }

  stop(): void {
    try { this.watcher?.close() } catch {}
    this.watcher = null
    for (const s of this.files.values()) if (s.debounce) clearTimeout(s.debounce)
    this.files.clear()
  }

  private schedule(name: string): void {
    let st = this.files.get(name)
    if (!st) {
      st = { debounce: null, lastJson: '' }
      this.files.set(name, st)
    }
    if (st.debounce) clearTimeout(st.debounce)
    st.debounce = setTimeout(() => this.read(name), 50)
  }

  private read(name: string): void {
    const st = this.files.get(name)
    if (!st) return
    st.debounce = null
    const full = join(this.dir, name)
    readFile(full, { encoding: 'utf8' }, (err, raw) => {
      if (err) return
      if (raw === st.lastJson) return
      st.lastJson = raw
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw) as Record<string, unknown>
      } catch { return }
      const state = isTabStatus(obj.state) ? obj.state : null
      if (!state) return
      const tabId = name.slice(0, -'.json'.length)
      const payload = {
        tabId,
        state,
        message: typeof obj.message === 'string' ? obj.message : undefined,
        ts: typeof obj.ts === 'string' ? obj.ts : undefined
      }
      const wc = resolveTabWc(tabId)
      if (!wc) return
      try { wc.send('state:event', payload) } catch {}
    })
  }
}
