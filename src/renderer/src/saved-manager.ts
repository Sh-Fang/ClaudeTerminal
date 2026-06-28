// 「展开管理」全屏 80% 弹窗：管理所有已保存的分组（重命名、删除、排序、删标签、恢复）。
// 主程通过 hooks 暴露最小接口，本类只负责 UI 渲染与交互。

import { icon } from './svg-icons'
import { escapeHtml, formatTs, shortPath, bindScrimDismiss, confirmDialog } from './ui-helpers'

export interface ManageTabView {
  id: string
  name: string
  sessions: number
  savedAt?: string
  lastTs?: string
}

export interface ManageGroupView {
  id: string
  name: string
  cwd: string
  savedAt: string
  tabs: ManageTabView[]
}

export interface SavedManagerHooks {
  getSaved(): ManageGroupView[]
  onReorder(savedIds: string[]): void
  onRename(savedId: string, newName: string): void
  onDelete(savedId: string): void
  onDeleteTab(savedId: string, tabId: string): void
  onRestoreAll(savedId: string): void
  onRestoreSelect(savedId: string): void
  getSidebarLimit(): number
}

export class SavedManager {
  private scrim: HTMLDivElement
  private body: HTMLDivElement
  private empty: HTMLDivElement
  private closeBtn: HTMLButtonElement
  private expanded = new Set<string>()
  private dragId: string | null = null

  constructor(private hooks: SavedManagerHooks) {
    this.scrim = document.getElementById('manageScrim') as HTMLDivElement
    this.body = document.getElementById('mg-body') as HTMLDivElement
    this.empty = document.getElementById('mg-empty') as HTMLDivElement
    this.closeBtn = document.getElementById('mg-close') as HTMLButtonElement
    this.closeBtn.addEventListener('click', () => this.close())
    bindScrimDismiss(this.scrim, () => this.close())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.scrim.hidden) this.close()
    })
    this.body.addEventListener('click', (e) => this.onBodyClick(e))
    this.body.addEventListener('blur', (e) => this.onBlur(e), true)
    this.body.addEventListener('keydown', (e) => this.onBodyKey(e))
    this.body.addEventListener('dragstart', (e) => this.onDragStart(e))
    this.body.addEventListener('dragover', (e) => this.onDragOver(e))
    this.body.addEventListener('dragleave', (e) => this.onDragLeave(e))
    this.body.addEventListener('drop', (e) => this.onDrop(e))
    this.body.addEventListener('dragend', () => this.onDragEnd())
  }

  open(): void {
    this.scrim.hidden = false
    this.render()
  }

  close(): void {
    this.scrim.hidden = true
    this.dragId = null
  }

  render(): void {
    if (this.scrim.hidden) return
    const list = this.hooks.getSaved()
    const limit = this.hooks.getSidebarLimit()
    const limitEl = document.getElementById('mg-limit-n')
    if (limitEl) limitEl.textContent = String(limit)
    this.body.innerHTML = ''
    this.empty.hidden = list.length > 0
    if (list.length === 0) return
    for (let i = 0; i < list.length; i++) {
      const visible = i < limit
      if (i === limit) {
        const sep = document.createElement('div')
        sep.className = 'mg-divider'
        sep.textContent = '以下分组仅在管理页可见'
        this.body.appendChild(sep)
      }
      this.body.appendChild(this.row(list[i], visible))
    }
  }

  private row(g: ManageGroupView, visible: boolean): HTMLDivElement {
    const expanded = this.expanded.has(g.id)
    const wrap = document.createElement('div')
    wrap.className = 'mg-row' + (visible ? ' is-visible' : '') + (expanded ? ' is-expanded' : '')
    wrap.draggable = true
    wrap.dataset.savedId = g.id
    const cwd = g.cwd ? escapeHtml(shortPath(g.cwd)) : '<span class="path-placeholder">(默认目录)</span>'
    wrap.innerHTML = `
      <div class="mg-head-row">
        <span class="mg-handle" title="拖动排序">${icon('grip-vertical', { size: 16 })}</span>
        <span class="mg-folder">${icon('folder')}</span>
        <div class="mg-info">
          <div class="mg-name" data-rename="${escapeHtml(g.id)}" title="点击重命名">${escapeHtml(g.name)}</div>
          <div class="mg-meta">${cwd} · ${g.tabs.length} 个标签 · ${escapeHtml(formatTs(g.savedAt))}</div>
        </div>
        ${visible ? '<span class="mg-badge" title="该分组会展示在侧边栏">侧边栏可见</span>' : ''}
        <button class="mg-btn" data-restore-select="${escapeHtml(g.id)}" title="选择恢复">${icon('rotate-ccw', { size: 14 })}</button>
        <button class="mg-btn mg-toggle" data-toggle="${escapeHtml(g.id)}" title="${expanded ? '收起标签' : '展开标签'}">${icon('chevron-down', { size: 14 })}</button>
        <button class="mg-btn mg-danger" data-delete="${escapeHtml(g.id)}" title="删除分组">${icon('trash', { size: 14 })}</button>
      </div>
      <div class="mg-tabs" ${expanded ? '' : 'hidden'}>
        ${this.tabsHtml(g)}
      </div>
    `
    return wrap
  }

  private tabsHtml(g: ManageGroupView): string {
    if (g.tabs.length === 0) {
      return '<div class="mg-tab-empty">这个保存的分组里已没有标签。</div>'
    }
    return g.tabs.map((t) => `
      <div class="mg-tab" data-saved="${escapeHtml(g.id)}" data-tab="${escapeHtml(t.id)}">
        <span class="mg-tab-name">${escapeHtml(t.name)}</span>
        <span class="mg-tab-meta">${t.sessions} 会话${t.lastTs ? ' · ' + escapeHtml(formatTs(t.lastTs)) : ''}</span>
        <button class="mg-btn mg-danger" data-tab-delete="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="从保存里删除此标签">${icon('trash', { size: 13 })}</button>
      </div>
    `).join('')
  }

  private onBodyClick(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    if (tgt.closest('[contenteditable="true"]')) return

    const tabDel = tgt.closest('[data-tab-delete]') as HTMLElement | null
    if (tabDel) {
      const [savedId, tabId] = (tabDel.dataset.tabDelete ?? '').split('::')
      if (!savedId || !tabId) return
      const tabName = tabDel.closest('.mg-tab')?.querySelector('.mg-tab-name')?.textContent?.trim() || '该标签'
      confirmDialog({
        title: `从保存里移除「${escapeHtml(tabName)}」？`,
        message: '只把该标签从保存记录里删除，已打开的实例不受影响。',
        okLabel: '删除',
        onOk: () => {
          this.hooks.onDeleteTab(savedId, tabId)
          this.render()
        }
      })
      return
    }
    const del = tgt.closest('[data-delete]') as HTMLElement | null
    if (del) {
      this.hooks.onDelete(del.dataset.delete!)
      return
    }
    const toggle = tgt.closest('[data-toggle]') as HTMLElement | null
    if (toggle) {
      const id = toggle.dataset.toggle!
      if (this.expanded.has(id)) this.expanded.delete(id)
      else this.expanded.add(id)
      this.render()
      return
    }
    const sel = tgt.closest('[data-restore-select]') as HTMLElement | null
    if (sel) {
      this.hooks.onRestoreSelect(sel.dataset.restoreSelect!)
      return
    }
    const rename = tgt.closest('[data-rename]') as HTMLElement | null
    if (rename) {
      this.beginRename(rename as HTMLElement)
    }
  }

  private beginRename(el: HTMLElement): void {
    const id = el.dataset.rename!
    const old = el.textContent ?? ''
    el.contentEditable = 'true'
    el.dataset.editing = '1'
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    el.focus()
    el.dataset.old = old
    el.dataset.savedId = id
  }

  private commitRename(el: HTMLElement, cancel: boolean): void {
    if (el.dataset.editing !== '1') return
    el.contentEditable = 'false'
    delete el.dataset.editing
    const v = (el.textContent || '').trim()
    const old = el.dataset.old ?? ''
    const id = el.dataset.savedId ?? ''
    delete el.dataset.old
    delete el.dataset.savedId
    if (cancel || !v) {
      el.textContent = old
      return
    }
    if (v !== old) this.hooks.onRename(id, v)
  }

  private onBlur(e: FocusEvent): void {
    const t = e.target as HTMLElement
    if (t.dataset?.editing === '1') this.commitRename(t, false)
  }

  private onBodyKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement
    if (t.dataset?.editing !== '1') return
    if (e.key === 'Enter') {
      e.preventDefault()
      this.commitRename(t, false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.commitRename(t, true)
    }
  }

  // ─── 拖动排序 ────────────────────────────────────────────────
  private onDragStart(e: DragEvent): void {
    const row = (e.target as HTMLElement).closest('.mg-row') as HTMLElement | null
    if (!row) return
    this.dragId = row.dataset.savedId || null
    row.classList.add('dragging')
    e.dataTransfer?.setData('text/plain', this.dragId ?? '')
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragId) return
    const row = (e.target as HTMLElement).closest('.mg-row') as HTMLElement | null
    if (!row || row.dataset.savedId === this.dragId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const rect = row.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    this.clearDropMarks()
    row.classList.add(before ? 'drop-before' : 'drop-after')
  }

  private onDragLeave(e: DragEvent): void {
    const row = (e.target as HTMLElement).closest('.mg-row') as HTMLElement | null
    if (!row) return
    if (e.relatedTarget && row.contains(e.relatedTarget as Node)) return
    row.classList.remove('drop-before', 'drop-after')
  }

  private onDrop(e: DragEvent): void {
    if (!this.dragId) return
    const row = (e.target as HTMLElement).closest('.mg-row') as HTMLElement | null
    if (!row) return
    e.preventDefault()
    const targetId = row.dataset.savedId
    const before = row.classList.contains('drop-before')
    this.clearDropMarks()
    if (!targetId || targetId === this.dragId) return

    const order = Array.from(this.body.querySelectorAll('.mg-row'))
      .map((el) => (el as HTMLElement).dataset.savedId)
      .filter((id): id is string => !!id)
    const fromIdx = order.indexOf(this.dragId)
    if (fromIdx < 0) return
    order.splice(fromIdx, 1)
    let toIdx = order.indexOf(targetId)
    if (toIdx < 0) return
    if (!before) toIdx += 1
    order.splice(toIdx, 0, this.dragId)
    this.hooks.onReorder(order)
    this.render()
  }

  private onDragEnd(): void {
    this.dragId = null
    this.clearDropMarks()
    this.body.querySelectorAll('.mg-row.dragging').forEach((el) => el.classList.remove('dragging'))
  }

  private clearDropMarks(): void {
    this.body.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after')
    })
  }
}
