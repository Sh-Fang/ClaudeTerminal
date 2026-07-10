import { escapeHtml, formatTs, sessionTitle, srcLabel, statusLabel } from './ui-helpers'
import type { TerminalTab, SessionRecord } from './terminal-tab'
import type { TabStatus } from './ui-helpers-types'

export interface ToolbarHooks {
  getActiveTab(): { tab: TerminalTab; groupName: string; groupCwd: string } | null
  switchSession(sessionId: string): void
  onSessionCtx(sessionId: string, x: number, y: number): void
  // 顶栏"启动 CC"按钮：在当前纯 pwsh 标签里起一次可被 app 接管的 cc 会话（等效 cct）
  startCcHere(): void
}

export class Toolbar {
  private crumbEl = document.querySelector('.toolbar .crumb') as HTMLDivElement
  private cbGroup = document.getElementById('cbGroup') as HTMLSpanElement
  private cbTab = document.getElementById('cbTab') as HTMLSpanElement
  private cbStatus = document.getElementById('cbStatus') as HTMLSpanElement
  private sessTime = document.getElementById('sessTime') as HTMLSpanElement
  private sessTitle = document.getElementById('sessTitle') as HTMLSpanElement
  private sessSelect = document.getElementById('sessionSelect') as HTMLDivElement
  private sessMenu = document.getElementById('sessionMenu') as HTMLDivElement
  private sessList = document.getElementById('sessList') as HTMLDivElement
  private sbCwd = document.getElementById('sbCwd') as HTMLSpanElement
  private startCcBtn = document.getElementById('startCcBtn') as HTMLButtonElement

  constructor(private hooks: ToolbarHooks) {
    this.startCcBtn.addEventListener('click', () => this.hooks.startCcHere())
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
      this.crumbEl?.classList.add('is-empty')
      this.cbGroup.textContent = ''
      this.cbTab.textContent = ''
      this.cbStatus.innerHTML = ''
      this.sessTime.textContent = ''
      this.sessTitle.textContent = '（无活动标签）'
      this.sessSelect.classList.add('empty')
      this.sessList.innerHTML = ''
      this.sbCwd.textContent = ''
      this.sbCwd.title = ''
      this.startCcBtn.classList.remove('show')
      this.closeMenu()
      return
    }
    this.crumbEl?.classList.remove('is-empty')
    this.sessSelect.classList.remove('empty')

    const { tab, groupName, groupCwd } = cur
    this.cbGroup.textContent = groupName
    this.cbTab.textContent = tab.name

    const st = (tab.status ?? 'idle') as TabStatus
    if (st === 'idle') this.cbStatus.innerHTML = ''
    else {
      const title = tab.note ? `${statusLabel(st)}：${tab.note}` : statusLabel(st)
      this.cbStatus.innerHTML =
        `<span class="status-pill sp-${st}" title="${escapeHtml(title)}"><span class="st-dot st-${st}"></span>${escapeHtml(statusLabel(st))}</span>`
    }

    const cur_sess = currentSession(tab)
    if (cur_sess) {
      const title = sessionTitle(cur_sess, tab.sessions)
      this.sessTime.textContent = formatTs(cur_sess.lastTs || cur_sess.createdAt)
      this.sessTitle.textContent = title
    } else {
      this.sessTime.textContent = ''
      this.sessTitle.textContent = '（未创建会话）'
    }
    this.sbCwd.textContent = groupCwd
    this.sbCwd.title = groupCwd

    // "启动 CC"入口显示条件：没勾自动启动 CC，且当下 cc 进程不活跃。
    // 用 ccActive 而非 sessions.length：cc 起过再退出时也让按钮回来，语义是"当前是纯 pwsh"。
    const pureNonCc = !tab.autoLaunchCC && !tab.ccActive
    this.startCcBtn.classList.toggle('show', pureNonCc)

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
          <div class="sess-title">${escapeHtml(sessionTitle(s, tab.sessions))}</div>
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
      it.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.hooks.onSessionCtx(s.sessionId, e.clientX, e.clientY)
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
