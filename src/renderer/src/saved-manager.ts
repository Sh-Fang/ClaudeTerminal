// 「展开管理」全屏 80% 弹窗：管理所有已保存的分组（重命名、删除、排序、删标签、恢复）。
// 主程通过 hooks 暴露最小接口，本类只负责 UI 渲染与交互。

import { icon } from './svg-icons'
import { escapeHtml, formatTs, fuzzySearch, highlightRanges, shortPath, bindScrimDismiss, confirmDialog, showCtxMenu, nameInitial, openSessionPicker, closeSessionPicker, type CtxItem, type Range, type SessPickEntry } from './ui-helpers'

// 单条会话的展示视图：供"点会话数弹出的小列表"渲染 + 会话级搜索。
// hasUserTitle 用来限定搜索范围 —— 只有手动重命名过的会话标题才进入搜索，默认「会话N」不参与。
export interface ManageSessionView {
  sessionId: string
  title: string
  hasUserTitle: boolean
  source: string
  ts?: string
  isActive: boolean // 是否该标签的默认活跃会话（activeSessionId）
}

export interface ManageTabView {
  id: string
  name: string
  sessions: ManageSessionView[]
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
  // 会话级恢复（入口②·管理页）：恢复该标签页，但把活跃会话指定为 sessionId（会话栈整份带过来）
  onRestoreTabAtSession(savedId: string, tabId: string, sessionId: string): void
  onAddTabToSaved(savedId: string): void
  onRenameWorkspace(wsId: string, newName: string): void
  onDeleteWorkspace(wsId: string): void
  onRestoreWorkspace(wsId: string): void
  onRestoreWorkspaceGroup(wsId: string, groupId: string): void
  onDeleteWorkspaceGroup(wsId: string, groupId: string): void
}

type ManageTabName = 'groups' | 'workspaces'

// 会话标题命中（仅搜重命名过的会话）：记录命中的会话 + 标题内高亮区间，
// 用于在对应标签行下方显示「↳ 会话「…」」提示，点它可直接恢复到该会话。
interface SessHit {
  tabId: string
  sessionId: string
  title: string
  hl?: Range[]
}

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

  // 打开管理弹窗。tab 指定落到哪个页（跟随侧边栏当前视图）；
  // focusId 不空时自动切到分组页、展开该分组并滚动到位 ——
  // 给侧边栏右键"管理本分组"用，省得用户进了弹窗还要再找一遍。
  open(focusId?: string, tab?: ManageTabName): void {
    this.scrim.hidden = false
    if (tab) this.activeTab = tab
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
    closeSessionPicker()
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
    closeSessionPicker() // 列表重建 → 关掉可能残留的会话浮层，避免锚点失效
    for (const btn of this.tabButtons) btn.classList.toggle('active', btn.dataset.mgTab === this.activeTab)
    if (this.activeTab === 'workspaces') {
      if (this.subEl) this.subEl.textContent = '整份工作区快照：点击展开分组，右键可重命名 / 恢复 / 删除。'
      this.searchInput.placeholder = '搜索：工作区名（支持模糊匹配）'
      this.renderWorkspaces()
      return
    }
    if (this.subEl) this.subEl.textContent = '按名称自动排序。点击展开标签，右键可重命名 / 恢复 / 删除。'
    this.searchInput.placeholder = '搜索：分组名 / 路径 / 标签名 / 会话名（支持模糊匹配）'
    const all = this.hooks.getSaved()
    const q = this.searchQuery.trim()
    const list = this.matchGroups(all, q)
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
    for (const { g, hl, sess } of list) {
      const el = this.row(g, hl, !!q, sess)
      el.dataset.initial = nameInitial(g.name)
      this.body.appendChild(el)
    }
    this.renderAz(list.map(({ g }) => nameInitial(g.name)))
  }

  // 命中规则：分组名(3) / 路径(1) / 任一标签名(2) 命中，或任一「重命名过的会话标题」命中
  // = 整组保留；有搜索时按最高匹配分倒序。会话命中额外记录到 sess(tabId → hits)，
  // 供标签行下方渲染 ↳ 会话提示。路径参与匹配但不高亮（短显示串下标对不上）。
  private matchGroups(
    all: ManageGroupView[],
    q: string
  ): Array<{ g: ManageGroupView; hl: Range[][]; sess: Map<string, SessHit[]> }> {
    if (!q) return all.map((g) => ({ g, hl: [] as Range[][], sess: new Map<string, SessHit[]>() }))
    const scored: Array<{ g: ManageGroupView; hl: Range[][]; sess: Map<string, SessHit[]>; score: number }> = []
    for (const g of all) {
      const fields = [g.name, g.cwd, ...g.tabs.map((t) => t.name)]
      const weights = [3, 1, ...g.tabs.map(() => 2)]
      const r = fuzzySearch(q, fields, weights)
      const sess = new Map<string, SessHit[]>()
      let bestSess = 0
      for (const t of g.tabs) {
        for (const s of t.sessions) {
          if (!s.hasUserTitle) continue // 只搜重命名过的标题，默认「会话N」不参与
          const sr = fuzzySearch(q, [s.title])
          if (!sr) continue
          const arr = sess.get(t.id) ?? []
          arr.push({ tabId: t.id, sessionId: s.sessionId, title: s.title, hl: sr.highlights[0] })
          sess.set(t.id, arr)
          if (sr.score > bestSess) bestSess = sr.score
        }
      }
      if (!r && sess.size === 0) continue
      scored.push({ g, hl: r?.highlights ?? [], sess, score: Math.max(r?.score ?? 0, bestSess) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map(({ g, hl, sess }) => ({ g, hl, sess }))
  }

  private renderWorkspaces(): void {
    const all = this.hooks.getSavedWorkspaces()
    const q = this.searchQuery.trim()
    const list: Array<{ w: ManageWorkspaceView; hl: Range[][] }> = q
      ? all
          .map((w) => {
            const r = fuzzySearch(q, [w.name])
            return r ? { w, hl: r.highlights, score: r.score } : null
          })
          .filter((x): x is { w: ManageWorkspaceView; hl: Range[][]; score: number } => !!x)
          .sort((a, b) => b.score - a.score)
      : all.map((w) => ({ w, hl: [] as Range[][] }))
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
    for (const { w, hl } of list) {
      const el = this.wsRow(w, hl, !!q)
      el.dataset.initial = nameInitial(w.name)
      this.body.appendChild(el)
    }
    this.renderAz(list.map(({ w }) => nameInitial(w.name)))
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
  private wsRow(w: ManageWorkspaceView, hl: Range[][] = [], forceExpand = false): HTMLDivElement {
    const expanded = forceExpand || this.expanded.has(w.id)
    const wrap = document.createElement('div')
    wrap.className = 'mg-row is-visible' + (expanded ? ' is-expanded' : '')
    wrap.dataset.wsId = w.id
    wrap.innerHTML = `
      <div class="mg-head-row" data-ws-row="${escapeHtml(w.id)}">
        <span class="mg-folder">${icon('layers')}</span>
        <div class="mg-info">
          <div class="mg-name" title="右键有更多操作，点击展开">${highlightRanges(w.name, hl[0])}</div>
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

  private row(
    g: ManageGroupView,
    hl: Range[][] = [],
    forceExpand = false,
    sess?: Map<string, SessHit[]>
  ): HTMLDivElement {
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
          <div class="mg-name" data-rename-group="${escapeHtml(g.id)}" title="右键有更多操作，点击展开">${highlightRanges(g.name, hl[0])}</div>
          <div class="mg-meta">${cwd} · ${g.tabs.length} 个标签 · ${escapeHtml(formatTs(g.savedAt))}</div>
        </div>
        <button class="mg-btn mg-toggle" data-toggle="${escapeHtml(g.id)}" title="${expanded ? '收起标签' : '展开标签'}">${icon('chevron-down', { size: 14 })}</button>
      </div>
      <div class="mg-tabs" ${expanded ? '' : 'hidden'}>
        ${this.tabsHtml(g, hl, sess)}
      </div>
    `
    return wrap
  }

  private tabsHtml(g: ManageGroupView, hl: Range[][] = [], sess?: Map<string, SessHit[]>): string {
    if (g.tabs.length === 0) {
      return '<div class="mg-tab-empty">这个保存的分组里已没有标签。</div>'
    }
    // 分组行 fields 顺序是 [name, cwd, tab0, tab1…]，所以标签 i 的高亮取 hl[2 + i]
    return g.tabs.map((t, i) => {
      const n = t.sessions.length
      // 可点条件：会话数 > 1 且至少有一条"重命名过的会话"——选择器只列重命名过的，
      // 默认名「会话 N」不作为可选项；一条重命名的都没有就退化为纯文本。
      const named = t.sessions.filter((s) => s.hasUserTitle).length
      const countHtml = n > 1 && named >= 1
        ? `<button type="button" class="mg-sess-count" data-sess-picker="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="选择要恢复的会话">${n} 会话 ▾</button>`
        : `${n} 会话`
      // 搜索命中的会话：标签行下方显示「↳ 会话「…」」，点它直接恢复到该会话
      const hits = sess?.get(t.id) ?? []
      const hitsHtml = hits
        .map(
          (h) => `
        <div class="mg-sess-hit" data-sess-restore="${escapeHtml(g.id)}::${escapeHtml(t.id)}::${escapeHtml(h.sessionId)}" title="恢复该标签页并打开此会话">
          <span class="mg-sess-hit-arrow">↳</span> 会话「${highlightRanges(h.title, h.hl)}」
        </div>`
        )
        .join('')
      return `
      <div class="mg-tab" data-saved="${escapeHtml(g.id)}" data-tab="${escapeHtml(t.id)}">
        <span class="mg-tab-name" data-rename-tab="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="右键有更多操作">${highlightRanges(t.name, hl[2 + i])}</span>
        <span class="mg-tab-meta">${countHtml}${t.lastTs ? ' · ' + escapeHtml(formatTs(t.lastTs)) : ''}</span>
        <button class="mg-btn mg-tab-restore" data-tab-restore="${escapeHtml(g.id)}::${escapeHtml(t.id)}" title="恢复该标签页到当前工作区">${icon('rotate-ccw', { size: 13 })}</button>
      </div>${hitsHtml}
    `
    }).join('')
  }

  // 点某标签的"会话数"徽标 → 弹会话小列表；选一条即恢复该标签页并以该会话为活跃会话。
  private openTabSessionPicker(anchor: HTMLElement): void {
    const [savedId, tabId] = (anchor.dataset.sessPicker ?? '').split('::')
    if (!savedId || !tabId) return
    const g = this.hooks.getSaved().find((x) => x.id === savedId)
    const t = g?.tabs.find((x) => x.id === tabId)
    if (!t || t.sessions.length < 2) return
    // 只列重命名过的会话，默认名「会话 N」不参与选择
    const named = t.sessions.filter((s) => s.hasUserTitle)
    if (named.length === 0) return
    const entries: SessPickEntry[] = named.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      source: s.source,
      ts: s.ts,
      isDefault: s.isActive
    }))
    openSessionPicker({
      anchor,
      entries,
      title: '选择要恢复的会话',
      onPick: (sid) => this.hooks.onRestoreTabAtSession(savedId, tabId, sid)
    })
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.render()
  }

  private onBodyClick(e: MouseEvent): void {
    const tgt = e.target as HTMLElement
    if (tgt.closest('[contenteditable="true"]')) return

    // 会话数徽标：弹会话小列表，选一条 = 直接恢复该标签页并以该会话为活跃会话（入口②）
    const sessPicker = tgt.closest('[data-sess-picker]') as HTMLElement | null
    if (sessPicker) {
      this.openTabSessionPicker(sessPicker)
      return
    }

    // 搜索命中的会话提示行：直接恢复该标签页并打开命中的会话
    const sessRestore = tgt.closest('[data-sess-restore]') as HTMLElement | null
    if (sessRestore) {
      const [savedId, tabId, sessionId] = (sessRestore.dataset.sessRestore ?? '').split('::')
      if (savedId && tabId && sessionId) this.hooks.onRestoreTabAtSession(savedId, tabId, sessionId)
      return
    }

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
        { label: '新增标签页', icon: icon('plus'), act: () => this.hooks.onAddTabToSaved(savedId) },
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
