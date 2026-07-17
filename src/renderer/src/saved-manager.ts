// 「展开管理」全屏 80% 弹窗：管理所有已保存的分组（重命名、删除、排序、删标签、恢复）。
// 主程通过 hooks 暴露最小接口，本类只负责 UI 渲染与交互。

import { icon } from './svg-icons'
import { escapeHtml, formatTs, fuzzyMatch, shortPath, bindScrimDismiss, confirmDialog, showCtxMenu, nameInitial, type CtxItem } from './ui-helpers'

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

export interface ManageWorkspaceGroupView {
  id: string
  name: string
  cwd: string
  tabCount: number
}

export interface ManageWorkspaceView {
  id: string
  name: string
  savedAt: string
  groupCount: number
  tabCount: number
  groups: ManageWorkspaceGroupView[]
}

export interface SavedManagerHooks {
  getSaved(): ManageGroupView[]
  getSavedWorkspaces(): ManageWorkspaceView[]
  onRename(savedId: string, newName: string): void
  onRenameTab(savedId: string, tabId: string, newName: string): void
  onDelete(savedId: string): void
  onDeleteTab(savedId: string, tabId: string): void
  onRestoreAll(savedId: string): void
  onRestoreSelect(savedId: string): void
  onRestoreOneTab(savedId: string, tabId: string): void
  onRenameWorkspace(wsId: string, newName: string): void
  onDeleteWorkspace(wsId: string): void
  onRestoreWorkspace(wsId: string): void
  onRestoreWorkspaceGroup(wsId: string, groupId: string): void
  onDeleteWorkspaceGroup(wsId: string, groupId: string): void
}

type ManageTabName = 'groups' | 'workspaces'

export class SavedManager {
  private scrim: HTMLDivElement
  private body: HTMLDivElement
  private empty: HTMLDivElement
  private closeBtn: HTMLButtonElement
  private searchInput: HTMLInputElement
  private subEl: HTMLParagraphElement | null
  private azEl: HTMLDivElement
  private tabButtons: HTMLButtonElement[]
  private activeTab: ManageTabName = 'groups'
  private expanded = new Set<string>()
  private searchQuery = ''

  constructor(private hooks: SavedManagerHooks) {
    this.scrim = document.getElementById('manageScrim') as HTMLDivElement
    this.body = document.getElementById('mg-body') as HTMLDivElement
    this.empty = document.getElementById('mg-empty') as HTMLDivElement
    this.closeBtn = document.getElementById('mg-close') as HTMLButtonElement
    this.searchInput = document.getElementById('mg-search') as HTMLInputElement
    this.subEl = document.getElementById('mg-sub') as HTMLParagraphElement | null
    this.azEl = document.getElementById('mg-az') as HTMLDivElement
    this.azEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-az]') as HTMLElement | null
      if (!btn || btn.classList.contains('disabled')) return
      const row = this.body.querySelector(`.mg-row[data-initial="${btn.dataset.az}"]`)
      row?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    this.tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.mg-tab-btn[data-mg-tab]'))
    for (const btn of this.tabButtons) {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.mgTab as ManageTabName))
    }
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
    this.body.addEventListener('contextmenu', (e) => this.onBodyCtx(e))
    this.body.addEventListener('blur', (e) => this.onBlur(e), true)
    this.body.addEventListener('keydown', (e) => this.onBodyKey(e))
  }

  // 打开管理弹窗；focusId 不空时自动切到分组页、展开该分组并滚动到位 ——
  // 给侧边栏右键"管理本分组"用，省得用户进了弹窗还要再找一遍。
  open(focusId?: string): void {
    this.scrim.hidden = false
    if (focusId) {
      this.activeTab = 'groups'
      this.expanded.add(focusId)
    }
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

  private switchTab(name: ManageTabName): void {
    if (this.activeTab === name) return
    this.activeTab = name
    this.searchQuery = ''
    this.searchInput.value = ''
    this.render()
  }

  render(): void {
    if (this.scrim.hidden) return
    for (const btn of this.tabButtons) btn.classList.toggle('active', btn.dataset.mgTab === this.activeTab)
    if (this.activeTab === 'workspaces') {
      if (this.subEl) this.subEl.textContent = '整份工作区快照：点击展开分组，右键可重命名 / 恢复 / 删除。'
      this.searchInput.placeholder = '搜索：工作区名（支持模糊匹配）'
      this.renderWorkspaces()
      return
    }
    if (this.subEl) this.subEl.textContent = '按名称自动排序。点击展开标签，右键可重命名 / 恢复 / 删除。'
    this.searchInput.placeholder = '搜索：分组名 / 路径 / 标签名（支持模糊匹配）'
    const all = this.hooks.getSaved()
    const q = this.searchQuery.trim()
    // 命中规则：分组名 / 路径 / 任一标签名 任一命中 = 整组保留
    const list = q
      ? all.filter((g) => fuzzyMatch(q, [g.name, g.cwd, ...g.tabs.map((t) => t.name)]))
      : all
    this.body.innerHTML = ''
    if (list.length === 0) {
      this.renderAz([])
      this.showEmpty(
        q ? '没有匹配的分组。' : '还没有已保存的分组。',
        q ? '换个关键词试试，或清空搜索。' : '右键打开的分组「保存分组」就会出现在这里。'
      )
      return
    }
    this.empty.hidden = true
    for (const g of list) {
      const el = this.row(g, !!q)
      el.dataset.initial = nameInitial(g.name)
      this.body.appendChild(el)
    }
    this.renderAz(list.map((g) => nameInitial(g.name)))
  }

  private renderWorkspaces(): void {
    const all = this.hooks.getSavedWorkspaces()
    const q = this.searchQuery.trim()
    const list = q ? all.filter((w) => fuzzyMatch(q, [w.name])) : all
    this.body.innerHTML = ''
    if (list.length === 0) {
      this.renderAz([])
      this.showEmpty(
        q ? '没有匹配的工作区。' : '还没有已保存的工作区。',
        q ? '换个关键词试试，或清空搜索。' : '在左侧「工作区」区空白处右键「保存该工作区」。'
      )
      return
    }
    this.empty.hidden = true
    for (const w of list) {
      const el = this.wsRow(w, !!q)
      el.dataset.initial = nameInitial(w.name)
      this.body.appendChild(el)
    }
    this.renderAz(list.map((w) => nameInitial(w.name)))
  }

  // 左缘 A~Z 竖排跳转条：只点亮当前列表里出现过的首字母；
  // 数字/符号开头的行归到 '#'（仅在需要时出现在最上方）。
  private renderAz(initials: string[]): void {
    const have = new Set(initials)
    const letters = [...(have.has('#') ? ['#'] : []), ...'abcdefghijklmnopqrstuvwxyz']
    this.azEl.innerHTML = letters
      .map((ch) => `<button type="button" class="mg-az-letter${have.has(ch) ? '' : ' disabled'}" data-az="${ch}">${ch === '#' ? '#' : ch.toUpperCase()}</button>`)
      .join('')
  }

  private showEmpty(title: string, sub: string): void {
    this.empty.hidden = false
    const first = this.empty.querySelector('div:first-child') as HTMLElement | null
    const subEl = this.empty.querySelector('.sub') as HTMLElement | null
    if (first) first.textContent = title
    if (subEl) subEl.textContent = sub
  }

  // 工作区行：与分组行同一套 mg-row 外观，展开显示分组列表（不再下钻到标签页）。
  // 行上不放操作按钮 —— 恢复/重命名/删除都在右键菜单里。
  private wsRow(w: ManageWorkspaceView, forceExpand = false): HTMLDivElement {
    const expanded = forceExpand || this.expanded.has(w.id)
    const wrap = document.createElement('div')
    wrap.className = 'mg-row is-visible' + (expanded ? ' is-expanded' : '')
    wrap.dataset.wsId = w.id
    wrap.innerHTML = `
      <div class="mg-head-row" data-ws-row="${escapeHtml(w.id)}">
        <span class="mg-folder">${icon('layers')}</span>
        <div class="mg-info">
          <div class="mg-name" title="右键有更多操作，点击展开">${escapeHtml(w.name)}</div>
          <div class="mg-meta">${w.groupCount} 个分组 · ${w.tabCount} 个标签 · ${escapeHtml(formatTs(w.savedAt))}</div>
        </div>
        <button class="mg-btn mg-toggle" data-ws-toggle="${escapeHtml(w.id)}" title="${expanded ? '收起分组' : '展开分组'}">${icon('chevron-down', { size: 14 })}</button>
      </div>
      <div class="mg-tabs" ${expanded ? '' : 'hidden'}>
        ${this.wsGroupsHtml(w)}
      </div>
    `
    return wrap
  }

  private wsGroupsHtml(w: ManageWorkspaceView): string {
    if (w.groups.length === 0) {
      return '<div class="mg-tab-empty">这个工作区快照里没有分组。</div>'
    }
    return w.groups.map((g) => {
      const cwd = g.cwd ? escapeHtml(shortPath(g.cwd)) : '<span class="path-placeholder">(默认目录)</span>'
      return `
      <div class="mg-tab mg-ws-grp" data-ws-grp="${escapeHtml(w.id)}::${escapeHtml(g.id)}">
        <span class="mg-ws-grp-ic">${icon('folder', { size: 13 })}</span>
        <span class="mg-tab-name">${escapeHtml(g.name)}</span>
        <span class="mg-tab-meta">${cwd} · ${g.tabCount} 个标签</span>
      </div>
    `
    }).join('')
  }

  private row(g: ManageGroupView, forceExpand = false): HTMLDivElement {
    // 搜索时强制展开，让用户一眼看到命中的是哪个标签
    const expanded = forceExpand || this.expanded.has(g.id)
    const wrap = document.createElement('div')
    // 侧边栏已经容器内滚动渲染全部，没有"可见 / 不可见"之分；统一一种外观即可。
    wrap.className = 'mg-row is-visible' + (expanded ? ' is-expanded' : '')
    wrap.dataset.savedId = g.id
    const cwd = g.cwd ? escapeHtml(shortPath(g.cwd)) : '<span class="path-placeholder">(默认目录)</span>'
    // 行上只留展开按钮；重命名/恢复/删除都收进右键菜单
    wrap.innerHTML = `
      <div class="mg-head-row" data-group-row="${escapeHtml(g.id)}">
        <span class="mg-folder">${icon('folder')}</span>
        <div class="mg-info">
          <div class="mg-name" data-rename-group="${escapeHtml(g.id)}" title="右键有更多操作，点击展开">${escapeHtml(g.name)}</div>
          <div class="mg-meta">${cwd} · ${g.tabs.length} 个标签 · ${escapeHtml(formatTs(g.savedAt))}</div>
        </div>
        <button class="mg-btn mg-toggle" data-toggle="${escapeHtml(g.id)}" title="${expanded ? '收起标签' : '展开标签'}">${icon('chevron-down', { size: 14 })}</button>
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
        <span class="mg-tab-name" data-rename-tab="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="右键有更多操作">${escapeHtml(t.name)}</span>
        <span class="mg-tab-meta">${t.sessions} 会话${t.lastTs ? ' · ' + escapeHtml(formatTs(t.lastTs)) : ''}</span>
        <button class="mg-btn mg-tab-restore" data-tab-restore="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="恢复该标签页到当前工作区">${icon('rotate-ccw', { size: 13 })}</button>
      </div>
    `).join('')
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.render()
  }

  private onBodyClick(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    if (tgt.closest('[contenteditable="true"]')) return

    const tabRestore = tgt.closest('[data-tab-restore]') as HTMLElement | null
    if (tabRestore) {
      const [savedId, tabId] = (tabRestore.dataset.tabRestore ?? '').split('::')
      if (savedId && tabId) this.hooks.onRestoreOneTab(savedId, tabId)
      return
    }
    const toggle = tgt.closest('[data-toggle]') as HTMLElement | null
    if (toggle) {
      this.toggleExpand(toggle.dataset.toggle!)
      return
    }
    const wsToggle = tgt.closest('[data-ws-toggle]') as HTMLElement | null
    if (wsToggle) {
      this.toggleExpand(wsToggle.dataset.wsToggle!)
      return
    }
    // 点击分组行 / 工作区行任意位置 = 展开/收起（与点展开按钮等效）
    const grpRow = tgt.closest('[data-group-row]') as HTMLElement | null
    if (grpRow) {
      this.toggleExpand(grpRow.dataset.groupRow!)
      return
    }
    const wsRow = tgt.closest('[data-ws-row]') as HTMLElement | null
    if (wsRow) {
      this.toggleExpand(wsRow.dataset.wsRow!)
    }
  }

  private confirmDeleteTab(savedId: string, tabId: string, tabName: string): void {
    confirmDialog({
      title: `从保存里移除「${escapeHtml(tabName)}」？`,
      message: '只把该标签从保存记录里删除，已打开的实例不受影响。',
      okLabel: '删除',
      onOk: () => {
        this.hooks.onDeleteTab(savedId, tabId)
        this.render()
      }
    })
  }

  // 弹窗里的单项右键 → 菜单：重命名 / 恢复 / 删除（删除均有二次确认）
  private onBodyCtx(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    // 正在改名时的右键放行（不弹菜单，也不拦默认行为）
    if (tgt.closest('[contenteditable="true"]')) return
    e.preventDefault()
    e.stopPropagation()

    // 标签行（分组展开后的行）
    const tabRow = tgt.closest('.mg-tab[data-tab]') as HTMLElement | null
    if (tabRow) {
      const savedId = tabRow.dataset.saved!
      const tabId = tabRow.dataset.tab!
      const nameEl = tabRow.querySelector('.mg-tab-name[data-rename-tab]') as HTMLElement | null
      const tabName = nameEl?.textContent?.trim() || '该标签'
      const items: CtxItem[] = [
        { label: '重命名', icon: icon('edit'), act: () => { if (nameEl) this.beginRenameTab(nameEl) } },
        { label: '恢复该标签页', icon: icon('rotate-ccw'), act: () => this.hooks.onRestoreOneTab(savedId, tabId) },
        { sep: true },
        { label: '删除标签页', icon: icon('trash'), danger: true, act: () => this.confirmDeleteTab(savedId, tabId, tabName) }
      ]
      showCtxMenu(items, e.clientX, e.clientY)
      return
    }

    // 工作区展开后的分组行：只有恢复和删除（工作区里的分组不支持重命名）
    const wsGrp = tgt.closest('.mg-ws-grp[data-ws-grp]') as HTMLElement | null
    if (wsGrp) {
      const [wsId, groupId] = (wsGrp.dataset.wsGrp ?? '').split('::')
      if (!wsId || !groupId) return
      const grpName = wsGrp.querySelector('.mg-tab-name')?.textContent?.trim() || '该分组'
      const items: CtxItem[] = [
        { label: '恢复该分组', icon: icon('rotate-ccw'), act: () => this.hooks.onRestoreWorkspaceGroup(wsId, groupId) },
        { sep: true },
        {
          label: '删除分组', icon: icon('trash'), danger: true,
          act: () => confirmDialog({
            title: `从工作区里删除「${escapeHtml(grpName)}」？`,
            message: '会删除该分组下的所有标签页。只动这份工作区留档，已保存分组和已打开的分组不受影响。',
            okLabel: '删除',
            onOk: () => this.hooks.onDeleteWorkspaceGroup(wsId, groupId)
          })
        }
      ]
      showCtxMenu(items, e.clientX, e.clientY)
      return
    }

    // 工作区行
    const wsRow = tgt.closest('.mg-row[data-ws-id]') as HTMLElement | null
    if (wsRow) {
      const wsId = wsRow.dataset.wsId!
      const nameEl = wsRow.querySelector('.mg-head-row .mg-name') as HTMLElement | null
      const items: CtxItem[] = [
        { label: '重命名', icon: icon('edit'), act: () => { if (nameEl) this.beginRenameWs(nameEl, wsId) } },
        { label: '恢复工作区', icon: icon('rotate-ccw'), act: () => this.hooks.onRestoreWorkspace(wsId) },
        { sep: true },
        { label: '删除工作区', icon: icon('trash'), danger: true, act: () => this.hooks.onDeleteWorkspace(wsId) }
      ]
      showCtxMenu(items, e.clientX, e.clientY)
      return
    }

    // 分组行
    const grpRow = tgt.closest('.mg-row[data-saved-id]') as HTMLElement | null
    if (grpRow) {
      const savedId = grpRow.dataset.savedId!
      const nameEl = grpRow.querySelector('[data-rename-group]') as HTMLElement | null
      const items: CtxItem[] = [
        { label: '重命名', icon: icon('edit'), act: () => { if (nameEl) this.beginRenameGroup(nameEl) } },
        { label: '恢复所有标签页', icon: icon('rotate-ccw'), act: () => this.hooks.onRestoreAll(savedId) },
        { sep: true },
        { label: '删除分组', icon: icon('trash'), danger: true, act: () => this.hooks.onDelete(savedId) }
      ]
      showCtxMenu(items, e.clientX, e.clientY)
    }
  }

  private beginRenameGroup(el: HTMLElement): void {
    el.dataset.editKind = 'group'
    this.beginRename(el, el.dataset.renameGroup!)
  }

  private beginRenameTab(el: HTMLElement): void {
    el.dataset.editKind = 'tab'
    this.beginRename(el, el.dataset.renameTab!)
  }

  private beginRenameWs(el: HTMLElement, wsId: string): void {
    el.dataset.editKind = 'workspace'
    this.beginRename(el, wsId)
  }

  private beginRename(el: HTMLElement, idPayload: string): void {
    const old = el.textContent ?? ''
    el.contentEditable = 'true'
    el.dataset.editing = '1'
    // 不全选：光标 collapse 到末尾，视觉上就是在原始文字上继续改
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    el.focus()
    el.dataset.old = old
    el.dataset.editPayload = idPayload
  }

  private commitRename(el: HTMLElement, cancel: boolean): void {
    if (el.dataset.editing !== '1') return
    el.contentEditable = 'false'
    delete el.dataset.editing
    const v = (el.textContent || '').trim()
    const old = el.dataset.old ?? ''
    const payload = el.dataset.editPayload ?? ''
    const kind = el.dataset.editKind ?? 'group'
    delete el.dataset.old
    delete el.dataset.editPayload
    delete el.dataset.editKind
    if (cancel || !v) {
      el.textContent = old
      return
    }
    if (v === old) return
    if (kind === 'tab') {
      const [savedId, tabId] = payload.split('::')
      if (savedId && tabId) this.hooks.onRenameTab(savedId, tabId, v)
    } else if (kind === 'workspace') {
      this.hooks.onRenameWorkspace(payload, v)
    } else {
      this.hooks.onRename(payload, v)
    }
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
