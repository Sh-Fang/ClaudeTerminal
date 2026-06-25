import { escapeHtml, statusLabel, statusShort } from './ui-helpers'
import type { TerminalTab } from './terminal-tab'
import type { TabStatus } from './ui-helpers-types'

export interface GroupView {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

export interface SavedView {
  id: string
  name: string
  cwd: string
  tabCount: number
  savedAt: string
}

export interface SidebarHooks {
  getGroups(): GroupView[]
  getSaved(): SavedView[]
  getActiveTabId(): string | null

  activateTab(tabId: string): void
  closeTab(tabId: string): void
  renameTab(tabId: string, newName: string): void
  toggleGroupCollapse(groupId: string): void

  onGroupCtx(groupId: string, x: number, y: number): void
  onTabCtx(tabId: string, x: number, y: number): void
  onSavedCtx(savedId: string, x: number, y: number): void

  addTabInGroup(groupId: string): void
  newGroup(): void
  restoreSaved(savedId: string): void
}

const ORDER: Record<TabStatus, number> = { error: 4, attention: 3, done: 2, busy: 1, idle: 0 }

function groupStatus(g: GroupView): TabStatus {
  let best: TabStatus = 'idle'
  for (const t of g.tabs) {
    const s = (t.status ?? 'idle') as TabStatus
    if (ORDER[s] > ORDER[best]) best = s
  }
  return best
}

export class Sidebar {
  private listEl: HTMLDivElement
  private savedEl: HTMLDivElement
  private newGroupBtn: HTMLDivElement

  constructor(private hooks: SidebarHooks) {
    this.listEl = document.getElementById('groupList') as HTMLDivElement
    this.savedEl = document.getElementById('savedList') as HTMLDivElement
    this.newGroupBtn = document.getElementById('newGroupBtn') as HTMLDivElement

    this.listEl.addEventListener('click', (e) => this.onListClick(e))
    this.listEl.addEventListener('contextmenu', (e) => this.onListCtx(e))
    this.listEl.addEventListener('dblclick', (e) => this.onListDblClick(e))
    this.savedEl.addEventListener('click', (e) => this.onSavedClick(e))
    this.savedEl.addEventListener('contextmenu', (e) => this.onSavedCtxEvent(e))
    this.newGroupBtn.addEventListener('click', () => this.hooks.newGroup())
  }

  render(): void {
    this.renderGroups()
    this.renderSaved()
  }

  private renderGroups(): void {
    const groups = this.hooks.getGroups()
    const activeTabId = this.hooks.getActiveTabId()
    this.listEl.innerHTML = ''
    if (groups.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'side-empty'
      empty.textContent = '还没有分组，点下方「新建分组」开始。'
      this.listEl.appendChild(empty)
      return
    }
    for (const g of groups) {
      const el = document.createElement('div')
      el.className = 'group' + (g.collapsed ? ' collapsed' : '')
      const gs = groupStatus(g)
      const headStatusDot =
        gs !== 'idle'
          ? `<span class="st-dot st-${gs} grp-st" title="组内有「${statusLabel(gs)}」的会话"></span>`
          : ''
      el.innerHTML = `
        <div class="group-head" data-g="${escapeHtml(g.id)}">
          <span class="group-caret">▾</span>
          <span class="group-folder">▣</span>
          <div class="group-meta">
            <div class="group-name">${escapeHtml(g.name)}</div>
            <div class="group-path" title="${escapeHtml(g.cwd)}">${escapeHtml(g.cwd)}</div>
          </div>
          ${headStatusDot}
          <span class="group-count">${g.tabs.length}</span>
          <span class="group-more" data-more="${escapeHtml(g.id)}" title="更多">⋯</span>
        </div>
        <div class="group-tabs">
          ${g.tabs.map((t) => this.tabRow(t, activeTabId === t.id)).join('')}
          <div class="group-addtab" data-addtab="${escapeHtml(g.id)}">
            <span class="ic">＋</span>新建会话标签
          </div>
        </div>
      `
      this.listEl.appendChild(el)
    }
  }

  private tabRow(t: TerminalTab, active: boolean): string {
    const st = (t.status ?? 'idle') as TabStatus
    const isIdle = st === 'idle'
    const badgeText = isIdle ? `${t.sessions.length}会话` : statusShort(st)
    const badgeCls = isIdle ? '' : ` bs-${st}`
    const dotTitle = `${statusLabel(st)}${t.note ? '：' + t.note : ''}`
    return `
      <div class="tab-row${active ? ' active' : ''}" data-t="${escapeHtml(t.id)}">
        <span class="st-dot st-${st}" title="${escapeHtml(dotTitle)}"></span>
        <span class="trow-name">${escapeHtml(t.name)}</span>
        <span class="trow-badge${badgeCls}">${escapeHtml(badgeText)}</span>
        <span class="trow-close" data-close="${escapeHtml(t.id)}" title="关闭标签">×</span>
      </div>`
  }

  private renderSaved(): void {
    const saved = this.hooks.getSaved()
    this.savedEl.innerHTML = ''
    if (saved.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'side-empty'
      empty.textContent = '右键分组「保存分组」可在此一键恢复。'
      this.savedEl.appendChild(empty)
      return
    }
    for (const s of saved) {
      const el = document.createElement('div')
      el.className = 'saved-row'
      el.dataset.saved = s.id
      el.innerHTML = `
        <div class="saved-ic">↺</div>
        <div class="saved-meta">
          <div class="saved-name">${escapeHtml(s.name)}</div>
          <div class="saved-sub">${s.tabCount} 个标签 · ${escapeHtml(s.cwd)} · ${escapeHtml(s.savedAt)}</div>
        </div>
        <div class="saved-restore" data-restore="${escapeHtml(s.id)}">↺ 恢复</div>
      `
      this.savedEl.appendChild(el)
    }
  }

  // ─── events ─────────────────────────────────────────────────
  private onListClick(e: MouseEvent): void {
    const tgt = e.target as HTMLElement

    const editing = tgt.closest('[contenteditable="true"]')
    if (editing) return

    const more = tgt.closest('[data-more]') as HTMLElement | null
    if (more) {
      e.stopPropagation()
      const rect = more.getBoundingClientRect()
      this.hooks.onGroupCtx(more.dataset.more!, rect.right, rect.bottom)
      return
    }
    const close = tgt.closest('[data-close]') as HTMLElement | null
    if (close) {
      e.stopPropagation()
      this.hooks.closeTab(close.dataset.close!)
      return
    }
    const add = tgt.closest('[data-addtab]') as HTMLElement | null
    if (add) {
      e.stopPropagation()
      this.hooks.addTabInGroup(add.dataset.addtab!)
      return
    }
    const row = tgt.closest('[data-t]') as HTMLElement | null
    if (row) {
      this.hooks.activateTab(row.dataset.t!)
      return
    }
    const head = tgt.closest('[data-g]') as HTMLElement | null
    if (head) {
      this.hooks.toggleGroupCollapse(head.dataset.g!)
    }
  }

  private onListCtx(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    const row = tgt.closest('[data-t]') as HTMLElement | null
    if (row) {
      e.preventDefault()
      this.hooks.onTabCtx(row.dataset.t!, e.clientX, e.clientY)
      return
    }
    const head = tgt.closest('[data-g]') as HTMLElement | null
    if (head) {
      e.preventDefault()
      this.hooks.onGroupCtx(head.dataset.g!, e.clientX, e.clientY)
    }
  }

  private onListDblClick(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest('[data-t]') as HTMLElement | null
    if (!row) return
    const tabId = row.dataset.t!
    const nameEl = row.querySelector('.trow-name') as HTMLSpanElement
    if (!nameEl) return
    this.startInlineRename(tabId, nameEl)
  }

  private startInlineRename(tabId: string, el: HTMLSpanElement): void {
    const old = el.textContent ?? ''
    el.contentEditable = 'true'
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    const commit = (cancel: boolean): void => {
      el.contentEditable = 'false'
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('keydown', onKey)
      const v = (el.textContent || '').trim()
      if (cancel || !v) {
        el.textContent = old
        return
      }
      if (v !== old) {
        this.hooks.renameTab(tabId, v)
      } else {
        el.textContent = old
      }
    }
    const onBlur = (): void => commit(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        commit(true)
      }
    }
    el.addEventListener('blur', onBlur)
    el.addEventListener('keydown', onKey)
  }

  private onSavedClick(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    const restore = tgt.closest('[data-restore]') as HTMLElement | null
    const row = tgt.closest('[data-saved]') as HTMLElement | null
    const id = restore?.dataset.restore || row?.dataset.saved
    if (id) this.hooks.restoreSaved(id)
  }

  private onSavedCtxEvent(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest('[data-saved]') as HTMLElement | null
    if (!row) return
    e.preventDefault()
    this.hooks.onSavedCtx(row.dataset.saved!, e.clientX, e.clientY)
  }
}
