import { escapeHtml, statusLabel, statusShort } from './ui-helpers'
import { icon } from './svg-icons'
import type { TerminalTab } from './terminal-tab'
import type { TabStatus } from './ui-helpers-types'

export interface GroupView {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
  dirty: boolean
}

export interface SavedView {
  id: string
  name: string
  cwd: string
  tabCount: number
  savedAt: string
}

export interface SavedWorkspaceView {
  id: string
  name: string
  savedAt: string
  groupCount: number
  tabCount: number
}

export interface SidebarHooks {
  getGroups(): GroupView[]
  getSaved(): SavedView[]
  getSavedWorkspaces(): SavedWorkspaceView[]
  getActiveTabId(): string | null

  activateTab(tabId: string): void
  closeTab(tabId: string): void
  renameTab(tabId: string, newName: string): void
  toggleGroupCollapse(groupId: string): void

  onGroupCtx(groupId: string, x: number, y: number): void
  onTabCtx(tabId: string, x: number, y: number): void
  onWorkspacePaneCtx(x: number, y: number): void

  addTabInGroup(groupId: string): void
  newGroup(): void
  reorderGroups(orderedIds: string[]): void
  restoreSaved(savedId: string): void
  restoreSavedWorkspace(wsId: string): void
  // view = 侧边栏当前选中的视图，管理弹窗直接落到对应 tab
  openManageSaved(view: 'groups' | 'workspaces'): void
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
  private newGroupBtn: HTMLButtonElement
  private manageBtn: HTMLDivElement
  private viewButtons: HTMLButtonElement[]
  // 底部区当前展示：已保存分组 / 已保存工作区（分开展示，头部小切换）
  private savedView: 'groups' | 'workspaces' = 'groups'
  private dragGroupId: string | null = null

  constructor(private hooks: SidebarHooks) {
    this.listEl = document.getElementById('groupList') as HTMLDivElement
    this.savedEl = document.getElementById('savedList') as HTMLDivElement
    this.newGroupBtn = document.getElementById('newGroupBtn') as HTMLButtonElement
    this.manageBtn = document.getElementById('manageSavedBtn') as HTMLDivElement
    this.viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#savedViewSwitch .sv-item'))
    for (const btn of this.viewButtons) {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view as 'groups' | 'workspaces'
        if (v === this.savedView) return
        this.savedView = v
        for (const b of this.viewButtons) b.classList.toggle('active', b === btn)
        this.renderSaved()
      })
    }

    this.listEl.addEventListener('click', (e) => this.onListClick(e))
    this.listEl.addEventListener('contextmenu', (e) => this.onListCtx(e))
    this.listEl.addEventListener('dblclick', (e) => this.onListDblClick(e))
    this.listEl.addEventListener('dragstart', (e) => this.onGroupDragStart(e))
    this.listEl.addEventListener('dragover', (e) => this.onGroupDragOver(e))
    this.listEl.addEventListener('dragleave', (e) => this.onGroupDragLeave(e))
    this.listEl.addEventListener('drop', (e) => this.onGroupDrop(e))
    this.listEl.addEventListener('dragend', () => this.onGroupDragEnd())
    this.savedEl.addEventListener('click', (e) => this.onSavedClick(e))
    // saved 行不再有右键菜单 —— 左键即恢复（分组弹选择窗，工作区弹确认窗）
    // 「工作区」区（顶部打开区）空白处右键 → 保存当前工作区
    const openSection = this.listEl.closest('.side-open') as HTMLElement | null
    openSection?.addEventListener('contextmenu', (e) => this.onOpenPaneCtx(e))
    this.newGroupBtn.addEventListener('click', () => this.hooks.newGroup())
    this.manageBtn?.addEventListener('click', () => this.hooks.openManageSaved(this.savedView))
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
      empty.textContent = '工作区为空'
      this.listEl.appendChild(empty)
      return
    }
    for (const g of groups) {
      const el = document.createElement('div')
      el.className = 'group' + (g.collapsed ? ' collapsed' : '')
      el.draggable = true
      el.dataset.dragId = g.id
      const gs = groupStatus(g)
      const headStatusDot =
        gs !== 'idle'
          ? `<span class="st-dot st-${gs} grp-st" title="组内有「${statusLabel(gs)}」的会话"></span>`
          : ''
      const cwdLabel = g.cwd
        ? escapeHtml(g.cwd)
        : '<span class="path-placeholder">(默认目录)</span>'
      const cwdTitle = g.cwd ? escapeHtml(g.cwd) : '使用用户主目录'
      const folderIcon = g.dirty ? icon('folder-filled') : icon('folder')
      const folderTitle = g.dirty ? '有未保存的改动，右键「保存分组」' : ''
      el.innerHTML = `
        <div class="group-head" data-g="${escapeHtml(g.id)}">
          <span class="group-caret">${icon('chevron-down', { size: 12, stroke: 2.4 })}</span>
          <span class="group-folder${g.dirty ? ' is-dirty' : ''}" title="${folderTitle}">${folderIcon}</span>
          <div class="group-meta">
            <div class="group-name">${escapeHtml(g.name)}</div>
            <div class="group-path" title="${cwdTitle}">${cwdLabel}</div>
          </div>
          ${headStatusDot}
          <span class="group-count">${g.tabs.length}</span>
          <span class="group-add" data-addtab="${escapeHtml(g.id)}" title="新建会话标签">${icon('plus', { size: 13, stroke: 2.2 })}</span>
          <span class="group-more" data-more="${escapeHtml(g.id)}" title="更多">${icon('more-horizontal')}</span>
        </div>
        <div class="group-tabs">
          ${g.tabs.map((t) => this.tabRow(t, activeTabId === t.id)).join('')}
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
    // dirty 点：跟 isGroupDirty 的过滤条件对齐——纯 pwsh tab 即便 dirty=true 也不显示
    // （纯 pwsh 没数据可保存，显示无意义）。承载 cc 的 tab 有未保存改动时在名字末尾贴一个
    // 黄点，跟分组头 folder-filled 用同一色系表达"dirty"语义。
    const showDirty = t.dirty && (t.autoLaunchCC || t.sessions.length > 0)
    const dirtyDot = showDirty ? `<span class="trow-dirty" title="有未保存改动"></span>` : ''
    return `
      <div class="tab-row${active ? ' active' : ''}" data-t="${escapeHtml(t.id)}">
        <span class="st-dot st-${st}" title="${escapeHtml(dotTitle)}"></span>
        <span class="trow-name">${escapeHtml(t.name)}</span>
        ${dirtyDot}
        <span class="trow-badge${badgeCls}">${escapeHtml(badgeText)}</span>
        <span class="trow-close" data-close="${escapeHtml(t.id)}" title="关闭标签">${icon('close', { size: 12, stroke: 2 })}</span>
      </div>`
  }

  private renderSaved(): void {
    // 分组 / 工作区分开展示，由头部「分组 / 工作区」小切换决定当前视图
    this.savedEl.innerHTML = ''
    if (this.savedView === 'workspaces') {
      const workspaces = this.hooks.getSavedWorkspaces()
      if (workspaces.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'side-empty'
        empty.textContent = '上方「工作区」区空白处右键「保存该工作区」。'
        this.savedEl.appendChild(empty)
        return
      }
      for (const w of workspaces) {
        const el = document.createElement('div')
        el.className = 'saved-row'
        el.dataset.savedWs = w.id
        el.innerHTML = `
          <div class="saved-ic saved-ic-ws">${icon('layers')}</div>
          <div class="saved-meta">
            <div class="saved-name">${escapeHtml(w.name)}</div>
            <div class="saved-sub">${w.groupCount} 个分组 · ${w.tabCount} 个标签 · ${escapeHtml(w.savedAt)}</div>
          </div>
        `
        this.savedEl.appendChild(el)
      }
      return
    }
    const saved = this.hooks.getSaved()
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
      const savedCwd = s.cwd
        ? escapeHtml(s.cwd)
        : '<span class="path-placeholder">(默认目录)</span>'
      el.innerHTML = `
        <div class="saved-ic">${icon('rotate-ccw')}</div>
        <div class="saved-meta">
          <div class="saved-name">${escapeHtml(s.name)}</div>
          <div class="saved-sub">${s.tabCount} 个标签 · ${savedCwd} · ${escapeHtml(s.savedAt)}</div>
        </div>
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
    // 不全选：光标 collapse 到末尾，视觉上就是在原始文字上继续改
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
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
    const row = tgt.closest('[data-saved]') as HTMLElement | null
    if (row?.dataset.saved) {
      this.hooks.restoreSaved(row.dataset.saved)
      return
    }
    const wsRow = tgt.closest('[data-saved-ws]') as HTMLElement | null
    if (wsRow?.dataset.savedWs) this.hooks.restoreSavedWorkspace(wsRow.dataset.savedWs)
  }

  private onOpenPaneCtx(e: MouseEvent): void {
    // 「工作区」区的右键：命中分组头/标签行时交给 onListCtx 的行级菜单，
    // 其余（空白、区标题）弹「保存该工作区」
    const tgt = e.target as HTMLElement
    if (tgt.closest('[data-t]') || tgt.closest('[data-g]')) return
    e.preventDefault()
    this.hooks.onWorkspacePaneCtx(e.clientX, e.clientY)
  }

  // ─── 分组拖动排序 ─────────────────────────────────────────────
  private onGroupDragStart(e: DragEvent): void {
    const row = (e.target as HTMLElement).closest('.group') as HTMLElement | null
    if (!row) return
    // 编辑中的标签名优先：不抢拖动
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) {
      e.preventDefault()
      return
    }
    this.dragGroupId = row.dataset.dragId || null
    row.classList.add('dragging')
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', this.dragGroupId ?? '')
      const head = row.querySelector('.group-head') as HTMLElement | null
      if (head) e.dataTransfer.setDragImage(head, 8, 8)
    }
  }

  private onGroupDragOver(e: DragEvent): void {
    if (!this.dragGroupId) return
    const row = (e.target as HTMLElement).closest('.group') as HTMLElement | null
    if (!row || row.dataset.dragId === this.dragGroupId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = row.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    this.clearGroupDropMarks()
    row.classList.add(before ? 'drop-before' : 'drop-after')
  }

  private onGroupDragLeave(e: DragEvent): void {
    const row = (e.target as HTMLElement).closest('.group') as HTMLElement | null
    if (!row) return
    if (e.relatedTarget && row.contains(e.relatedTarget as Node)) return
    row.classList.remove('drop-before', 'drop-after')
  }

  private onGroupDrop(e: DragEvent): void {
    if (!this.dragGroupId) return
    const row = (e.target as HTMLElement).closest('.group') as HTMLElement | null
    if (!row) return
    e.preventDefault()
    const targetId = row.dataset.dragId
    const before = row.classList.contains('drop-before')
    this.clearGroupDropMarks()
    if (!targetId || targetId === this.dragGroupId) return

    const order = Array.from(this.listEl.querySelectorAll('.group'))
      .map((el) => (el as HTMLElement).dataset.dragId)
      .filter((id): id is string => !!id)
    const fromIdx = order.indexOf(this.dragGroupId)
    if (fromIdx < 0) return
    order.splice(fromIdx, 1)
    let toIdx = order.indexOf(targetId)
    if (toIdx < 0) return
    if (!before) toIdx += 1
    order.splice(toIdx, 0, this.dragGroupId)
    this.hooks.reorderGroups(order)
  }

  private onGroupDragEnd(): void {
    this.dragGroupId = null
    this.clearGroupDropMarks()
    this.listEl.querySelectorAll('.group.dragging').forEach((el) => el.classList.remove('dragging'))
  }

  private clearGroupDropMarks(): void {
    this.listEl.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after')
    })
  }
}
