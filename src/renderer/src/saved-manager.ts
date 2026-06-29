// 「展开管理」全屏 80% 弹窗：管理所有已保存的分组（重命名、删除、排序、删标签、恢复）。
// 主程通过 hooks 暴露最小接口，本类只负责 UI 渲染与交互。

import { icon } from './svg-icons'
import { escapeHtml, formatTs, fuzzyMatch, shortPath, bindScrimDismiss, confirmDialog } from './ui-helpers'

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
  onRename(savedId: string, newName: string): void
  onDelete(savedId: string): void
  onDeleteTab(savedId: string, tabId: string): void
  onRestoreAll(savedId: string): void
  onRestoreSelect(savedId: string): void
}

export class SavedManager {
  private scrim: HTMLDivElement
  private body: HTMLDivElement
  private empty: HTMLDivElement
  private closeBtn: HTMLButtonElement
  private searchInput: HTMLInputElement
  private expanded = new Set<string>()
  private searchQuery = ''

  constructor(private hooks: SavedManagerHooks) {
    this.scrim = document.getElementById('manageScrim') as HTMLDivElement
    this.body = document.getElementById('mg-body') as HTMLDivElement
    this.empty = document.getElementById('mg-empty') as HTMLDivElement
    this.closeBtn = document.getElementById('mg-close') as HTMLButtonElement
    this.searchInput = document.getElementById('mg-search') as HTMLInputElement
    this.closeBtn.addEventListener('click', () => this.close())
    bindScrimDismiss(this.scrim, () => this.close())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.scrim.hidden) {
        // 有搜索词时先清空搜索，再次 ESC 才关弹窗 —— 跟浏览器搜索框直觉一致
        if (this.searchQuery) {
          this.searchInput.value = ''
          this.searchQuery = ''
          this.render()
          return
        }
        this.close()
      }
    })
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value
      this.render()
    })
    this.body.addEventListener('click', (e) => this.onBodyClick(e))
    this.body.addEventListener('blur', (e) => this.onBlur(e), true)
    this.body.addEventListener('keydown', (e) => this.onBodyKey(e))
  }

  // 打开管理弹窗；focusId 不空时自动展开该分组并滚动到位 ——
  // 给侧边栏右键"管理本分组"用，省得用户进了弹窗还要再找一遍。
  open(focusId?: string): void {
    this.scrim.hidden = false
    if (focusId) this.expanded.add(focusId)
    this.searchQuery = ''
    this.searchInput.value = ''
    this.render()
    if (!focusId) return
    const row = this.body.querySelector(`.mg-row[data-saved-id="${focusId.replace(/["\\]/g, '\\$&')}"]`)
    if (row) row.scrollIntoView({ block: 'center' })
  }

  close(): void {
    this.scrim.hidden = true
  }

  render(): void {
    if (this.scrim.hidden) return
    const all = this.hooks.getSaved()
    const q = this.searchQuery.trim()
    // 命中规则：分组名 / 路径 / 任一标签名 任一命中 = 整组保留
    const list = q
      ? all.filter((g) => fuzzyMatch(q, [g.name, g.cwd, ...g.tabs.map((t) => t.name)]))
      : all
    this.body.innerHTML = ''
    if (list.length === 0) {
      this.empty.hidden = false
      const first = this.empty.querySelector('div:first-child') as HTMLElement | null
      const sub = this.empty.querySelector('.sub') as HTMLElement | null
      if (q) {
        if (first) first.textContent = '没有匹配的分组。'
        if (sub) sub.textContent = '换个关键词试试，或清空搜索。'
      } else {
        if (first) first.textContent = '还没有已保存的分组。'
        if (sub) sub.textContent = '右键打开的分组「保存分组」就会出现在这里。'
      }
      return
    }
    this.empty.hidden = true
    for (const g of list) this.body.appendChild(this.row(g, !!q))
  }

  private row(g: ManageGroupView, forceExpand = false): HTMLDivElement {
    // 搜索时强制展开，让用户一眼看到命中的是哪个标签
    const expanded = forceExpand || this.expanded.has(g.id)
    const wrap = document.createElement('div')
    // 侧边栏已经容器内滚动渲染全部，没有"可见 / 不可见"之分；统一一种外观即可。
    wrap.className = 'mg-row is-visible' + (expanded ? ' is-expanded' : '')
    wrap.dataset.savedId = g.id
    const cwd = g.cwd ? escapeHtml(shortPath(g.cwd)) : '<span class="path-placeholder">(默认目录)</span>'
    wrap.innerHTML = `
      <div class="mg-head-row">
        <span class="mg-folder">${icon('folder')}</span>
        <div class="mg-info">
          <div class="mg-name" data-rename="${escapeHtml(g.id)}" title="点击重命名">${escapeHtml(g.name)}</div>
          <div class="mg-meta">${cwd} · ${g.tabs.length} 个标签 · ${escapeHtml(formatTs(g.savedAt))}</div>
        </div>
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

}
