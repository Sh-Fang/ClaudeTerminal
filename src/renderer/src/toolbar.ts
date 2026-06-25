import { escapeHtml, formatTs, shortPath, srcLabel, statusLabel } from './ui-helpers'
import type { TerminalTab, SessionRecord } from './terminal-tab'
import type { TabStatus } from './ui-helpers-types'

export interface ToolbarHooks {
  getActiveTab(): { tab: TerminalTab; groupName: string; groupCwd: string } | null
  switchSession(sessionId: string): void
}

export class Toolbar {
  private cbGroup = document.getElementById('cbGroup') as HTMLSpanElement
  private cbTab = document.getElementById('cbTab') as HTMLSpanElement
  private cbStatus = document.getElementById('cbStatus') as HTMLSpanElement
  private cbCwd = document.getElementById('cbCwd') as HTMLSpanElement
  private sessTime = document.getElementById('sessTime') as HTMLSpanElement
  private sessTitle = document.getElementById('sessTitle') as HTMLSpanElement
  private sessSelect = document.getElementById('sessionSelect') as HTMLDivElement
  private sessMenu = document.getElementById('sessionMenu') as HTMLDivElement
  private sessList = document.getElementById('sessList') as HTMLDivElement
  private sbSession = document.getElementById('sbSession') as HTMLSpanElement
  private sbCwd = document.getElementById('sbCwd') as HTMLSpanElement

  constructor(private hooks: ToolbarHooks) {
    this.sessSelect.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.sessSelect.classList.contains('empty')) return
      this.toggleMenu()
    })
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.session-menu') &&
          !(e.target as HTMLElement).closest('.session-select')) {
        this.closeMenu()
      }
    })
  }

  render(): void {
    const cur = this.hooks.getActiveTab()
    if (!cur) {
      this.cbGroup.textContent = ''
      this.cbTab.textContent = ''
      this.cbStatus.innerHTML = ''
      this.cbCwd.textContent = ''
      this.cbCwd.title = ''
      this.sessTime.textContent = ''
      this.sessTitle.textContent = '（无活动标签）'
      this.sessSelect.classList.add('empty')
      this.sessList.innerHTML = ''
      this.sbSession.textContent = ''
      this.sbCwd.textContent = ''
      this.closeMenu()
      return
    }
    this.sessSelect.classList.remove('empty')

    const { tab, groupName, groupCwd } = cur
    this.cbGroup.textContent = groupName
    this.cbTab.textContent = tab.name
    this.cbCwd.textContent = shortPath(groupCwd)
    this.cbCwd.title = groupCwd

    const st = (tab.status ?? 'idle') as TabStatus
    if (st === 'idle') this.cbStatus.innerHTML = ''
    else {
      const title = tab.note ? `${statusLabel(st)}：${tab.note}` : statusLabel(st)
      this.cbStatus.innerHTML =
        `<span class="status-pill sp-${st}" title="${escapeHtml(title)}"><span class="st-dot st-${st}"></span>${escapeHtml(statusLabel(st))}</span>`
    }

    const cur_sess = currentSession(tab)
    if (cur_sess) {
      const title = sessionTitle(cur_sess)
      this.sessTime.textContent = formatTs(cur_sess.lastTs || cur_sess.createdAt)
      this.sessTitle.textContent = title
      this.sbSession.textContent = `session ${cur_sess.sessionId.slice(0, 8)}`
    } else {
      this.sessTime.textContent = ''
      this.sessTitle.textContent = '（未创建会话）'
      this.sbSession.textContent = ''
    }
    this.sbCwd.textContent = groupCwd

    this.renderSessList(tab)
  }

  private renderSessList(tab: TerminalTab): void {
    this.sessList.innerHTML = ''
    if (tab.sessions.length === 0) {
      const empty = document.createElement('div')
      empty.style.padding = '10px 12px'
      empty.style.fontSize = '12px'
      empty.style.color = 'var(--mute)'
      empty.textContent = '没有会话记录。激活标签后 cc 会自动创建首个会话。'
      this.sessList.appendChild(empty)
      return
    }
    // 倒序展示：栈顶在最上面
    const list = [...tab.sessions].reverse()
    for (const s of list) {
      const isCurrent = s.sessionId === tab.activeSessionId
      const it = document.createElement('div')
      it.className = 'sess-item' + (isCurrent ? ' current' : '')
      it.dataset.sessionId = s.sessionId
      it.innerHTML = `
        <span class="sdot"></span>
        <div class="sess-body">
          <div class="sess-title">${escapeHtml(sessionTitle(s))}</div>
          <div class="sess-meta">${escapeHtml(formatTs(s.lastTs || s.createdAt))} · <span class="src">${escapeHtml(srcLabel(s.source))}</span> · ${escapeHtml(s.sessionId.slice(0, 8))}${isCurrent ? ' · <span class="cur">当前</span>' : ''}</div>
        </div>
      `
      it.addEventListener('click', () => {
        if (isCurrent) {
          this.closeMenu()
          return
        }
        this.closeMenu()
        this.hooks.switchSession(s.sessionId)
      })
      this.sessList.appendChild(it)
    }
  }

  private toggleMenu(): void {
    if (this.sessMenu.classList.contains('open')) this.closeMenu()
    else this.openMenu()
  }
  private openMenu(): void {
    this.sessMenu.classList.add('open')
    this.sessSelect.classList.add('open')
  }
  private closeMenu(): void {
    this.sessMenu.classList.remove('open')
    this.sessSelect.classList.remove('open')
  }
}

function currentSession(tab: TerminalTab): SessionRecord | undefined {
  if (!tab.activeSessionId) return tab.sessions[tab.sessions.length - 1]
  return (
    tab.sessions.find((s) => s.sessionId === tab.activeSessionId) ??
    tab.sessions[tab.sessions.length - 1]
  )
}

function sessionTitle(s: SessionRecord): string {
  if (s.aiTitle) return s.aiTitle
  return `（待 Claude 生成标题…${s.sessionId.slice(0, 8)}）`
}
