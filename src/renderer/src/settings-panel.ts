import { DEFAULT_SETTINGS, type Settings, type ThemePreset, type AppTheme, type CursorStyle } from './themes'
import { bindScrimDismiss, confirmDialog, showCtxMenu } from './ui-helpers'
import { icon } from './svg-icons'
import { MODEL_GROUPS } from './session-info'

const FOLLOW_CC_LABEL = '跟随 cc 默认'

// CSS.escape polyfill：版本号里含 `.` 需要转义才能塞进 selector
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/([^\w-])/g, '\\$1')
}

// 简易 semver 比较：与主进程 cc-versions.ts 里保持一致；pre-release 视为更小
function cmpSemver(a: string, b: string): number {
  const [ah, ap = ''] = a.split('-', 2)
  const [bh, bp = ''] = b.split('-', 2)
  const pa = ah.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = bh.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

export interface SettingsPanelHooks {
  getSettings(): Settings
  setSettings(s: Settings): void
}

export class SettingsPanel {
  private scrim = document.getElementById('settingsScrim') as HTMLDivElement
  private btn = document.getElementById('settingsBtn') as HTMLButtonElement
  private closeBtn = document.getElementById('set-close') as HTMLButtonElement
  private resetBtn = document.getElementById('set-reset') as HTMLButtonElement

  private fFamily = document.getElementById('set-font-family') as HTMLInputElement
  private fSize = document.getElementById('set-font-size') as HTMLInputElement
  private fLine = document.getElementById('set-line-height') as HTMLInputElement
  private fTheme = document.getElementById('set-theme') as HTMLDivElement
  private fAppTheme = document.getElementById('set-app-theme') as HTMLDivElement
  private fCursorGroup = document.getElementById('set-cursor-style') as HTMLDivElement
  private fCursorBlink = document.getElementById('set-cursor-blink') as HTMLInputElement
  private fScrollback = document.getElementById('set-scrollback') as HTMLInputElement
  private fDefaultCC = document.getElementById('set-default-cc') as HTMLInputElement
  private fDefaultModel = document.getElementById('set-default-model') as HTMLButtonElement
  private fDisableUpd = document.getElementById('set-disable-update') as HTMLInputElement
  private fDowngradeSec = document.getElementById('set-downgrade-sec') as HTMLDivElement
  private fShowUsage = document.getElementById('set-show-usage') as HTMLInputElement
  private fShowFloater = document.getElementById('set-show-floater') as HTMLInputElement
  private fNpmReg = document.getElementById('set-npm-registry') as HTMLInputElement
  private ccList = document.getElementById('cc-ver-list') as HTMLDivElement
  private ccPager = document.getElementById('cc-ver-pager') as HTMLDivElement
  private ccCurLabel = document.getElementById('cc-ver-current-label') as HTMLSpanElement
  private ccSearch = document.getElementById('cc-ver-search') as HTMLInputElement
  private ccOnlyInstalled = document.getElementById('cc-ver-only-installed') as HTMLInputElement
  private ccRefreshBtn = document.getElementById('cc-ver-refresh') as HTMLButtonElement
  private ccHint = document.getElementById('cc-ver-hint') as HTMLDivElement
  private ccInstalledSet = new Set<string>()
  private ccInstalledMap = new Map<string, { path: string; active: boolean }>()
  private ccRemote: string[] = []
  private ccActiveVersion = ''    // 托管路径命中的版本
  private ccDetectedVersion = ''  // 从 claudePath 反查到的版本（含自定义路径场景）
  private ccInstallingVer = ''
  private ccLoaded = false
  private ccPage = 1
  private readonly CC_PAGE_SIZE = 10
  // 首次拉完远端后要自动跳到含使用中版本的页；之后用户改 filter/search 时不再自动跳
  private ccAutoJumpPending = true
  // 安装进度
  private ccInstallStartTs = 0
  private ccInstallPhase = ''
  private ccInstallTicker: number | null = null
  private ccInstallPhaseUnsub: (() => void) | null = null
  private lastDisableUpd: boolean | null = null

  private navButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.set-nav-item')
  )
  private sections = Array.from(
    document.querySelectorAll<HTMLDivElement>('.set-section[data-section]')
  )
  private currentCursor: CursorStyle = 'block'

  constructor(private hooks: SettingsPanelHooks) {
    this.btn.addEventListener('click', () => this.open())
    this.closeBtn.addEventListener('click', () => this.close())
    this.resetBtn.addEventListener('click', () => {
      confirmDialog({
        title: '恢复默认设置',
        message: '确定把所有设置恢复到默认？<br>字体 / 光标 / 主题 / 镜像 等都会被重置。<br>此操作不可撤销。',
        okLabel: '恢复',
        danger: true,
        onOk: () => {
          this.bindFromSettings(DEFAULT_SETTINGS)
          this.commitChange()
        }
      })
    })
    bindScrimDismiss(this.scrim, () => this.close())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.scrim.hidden) this.close()
    })

    for (const nav of this.navButtons) {
      nav.addEventListener('click', () => this.activateSection(nav.dataset.section || 'appearance'))
    }

    for (const item of this.fCursorGroup.querySelectorAll<HTMLButtonElement>('.seg-item')) {
      item.addEventListener('click', () => {
        const v = item.dataset.val as CursorStyle
        if (!v) return
        this.currentCursor = v
        this.paintCursorActive()
        this.commitChange()
      })
    }

    this.initSeg(this.fTheme)
    this.initSeg(this.fAppTheme)
    this.initSeg(this.fDowngradeSec)
    this.fDefaultModel.addEventListener('click', (e) => {
      e.stopPropagation() // 挡掉 ui-helpers 里 document.click 关 ctx 的兜底
      this.openModelPicker()
    })

    const live = [this.fFamily, this.fSize, this.fLine, this.fScrollback, this.fNpmReg]
    const changeOnly = [this.fCursorBlink, this.fDefaultCC, this.fDisableUpd, this.fShowUsage, this.fShowFloater]
    for (const el of live) {
      el.addEventListener('input', () => this.commitChange())
      el.addEventListener('change', () => this.commitChange())
    }
    for (const el of changeOnly) {
      el.addEventListener('change', () => this.commitChange())
    }

    this.ccRefreshBtn.addEventListener('click', () => void this.refresh(true))
    this.ccSearch.addEventListener('input', () => { this.ccPage = 1; this.renderList() })
    this.ccOnlyInstalled.addEventListener('change', () => { this.ccPage = 1; this.renderList() })
  }

  open(): void {
    this.bindFromSettings(this.hooks.getSettings())
    this.activateSection('appearance')
    void this.ensureUpdConsistency()
    this.scrim.hidden = false
  }
  close(): void {
    this.scrim.hidden = true
  }

  private activateSection(name: string): void {
    for (const nav of this.navButtons) nav.classList.toggle('active', nav.dataset.section === name)
    for (const sec of this.sections) sec.hidden = sec.dataset.section !== name
    if (name === 'claude') {
      this.ensureInstallPhaseSub()
      // 首次打开必拉；之后只刷新已安装（远端保持缓存，靠「刷新」按钮显式重拉）
      void this.refresh(!this.ccLoaded)
    }
  }

  private ensureInstallPhaseSub(): void {
    if (this.ccInstallPhaseUnsub) return
    this.ccInstallPhaseUnsub = window.term.onCcInstallPhase(({ version, phase }) => {
      if (version === this.ccInstallingVer) {
        this.ccInstallPhase = phase
        this.updateInstallingRow()
      }
    })
  }

  // 拉数据 + 重渲染。fetchRemote=true 时会重新问远端（首次打开或用户点「刷新」）。
  private async refresh(fetchRemote: boolean): Promise<void> {
    if (fetchRemote) {
      this.ccRefreshBtn.disabled = true
      this.ccRefreshBtn.classList.add('spinning')
      try {
        const [installed, remoteRes, curVer] = await Promise.all([
          window.term.ccListInstalled(),
          window.term.ccListRemote(),
          window.term.ccCurrentVersion()
        ])
        this.applyInstalled(installed, curVer)
        if (remoteRes.ok) {
          this.ccRemote = remoteRes.versions
          this.ccLoaded = true
          this.setCcHint('', '')
        } else {
          this.setCcHint(`远端版本拉取失败：${remoteRes.error ?? '未知'}`, 'err')
        }
      } finally {
        this.ccRefreshBtn.disabled = false
        this.ccRefreshBtn.classList.remove('spinning')
      }
    } else {
      const [installed, curVer] = await Promise.all([
        window.term.ccListInstalled(),
        window.term.ccCurrentVersion()
      ])
      this.applyInstalled(installed, curVer)
    }
    // 首次拉完远端 → 自动跳到含使用中版本的页；用户改 filter 后不再自动跳
    if (fetchRemote && this.ccAutoJumpPending) {
      const pg = this.pageOfCurrent()
      if (pg > 0) this.ccPage = pg
      this.ccAutoJumpPending = false
    }
    this.renderList()
  }

  private applyInstalled(list: import('../../preload').InstalledCcVersion[], curVer: string | null): void {
    this.ccInstalledSet = new Set(list.map((v) => v.version))
    this.ccInstalledMap = new Map(list.map((v) => [v.version, { path: v.path, active: v.active }]))
    const active = list.find((v) => v.active)
    this.ccActiveVersion = active?.version ?? ''
    this.ccDetectedVersion = curVer ?? ''
    const cur = this.hooks.getSettings().claudePath?.trim() || ''
    if (active) {
      this.ccCurLabel.innerHTML = `<span class="v">v${active.version}</span><span class="src">托管路径</span>`
    } else if (cur) {
      this.ccCurLabel.innerHTML = curVer
        ? `<span class="v">v${curVer}</span><span class="src">自定义路径</span>`
        : `<span class="v">${cur}</span><span class="src">未识别版本</span>`
    } else {
      this.ccCurLabel.innerHTML = `<span class="v">claude</span><span class="src">走系统 PATH</span>`
    }
  }

  // 合并 + 过滤后的版本序列（供分页与页码计算复用）
  private computeFiltered(): string[] {
    const q = this.ccSearch.value.trim().toLowerCase()
    const onlyInstalled = this.ccOnlyInstalled.checked
    const all = new Set<string>(this.ccRemote)
    for (const v of this.ccInstalledSet) all.add(v)
    if (this.ccDetectedVersion) all.add(this.ccDetectedVersion)
    const versions = Array.from(all).sort(cmpSemver).reverse()
    // 「已安装」= 托管的 ∪ 反查到的（自定义路径 / 系统 PATH 里的 claude 都算）
    const isInstalledForFilter = (v: string): boolean =>
      this.ccInstalledSet.has(v) || (!!this.ccDetectedVersion && v === this.ccDetectedVersion)
    return versions.filter((v) => {
      if (onlyInstalled && !isInstalledForFilter(v)) return false
      if (q && !v.toLowerCase().includes(q)) return false
      return true
    })
  }

  // 使用中版本在当前过滤序列中所属的页（1-based）；不在或无 => 0
  private pageOfCurrent(): number {
    const target = this.ccActiveVersion || this.ccDetectedVersion
    if (!target) return 0
    const list = this.computeFiltered()
    const idx = list.indexOf(target)
    if (idx < 0) return 0
    return Math.floor(idx / this.CC_PAGE_SIZE) + 1
  }

  private renderList(): void {
    const filtered = this.computeFiltered()
    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / this.CC_PAGE_SIZE))
    if (this.ccPage > totalPages) this.ccPage = totalPages
    if (this.ccPage < 1) this.ccPage = 1

    this.ccList.innerHTML = ''
    if (total === 0) {
      const empty = document.createElement('div')
      empty.className = 'cvempty'
      empty.textContent = this.ccLoaded ? '没有匹配的版本' : '点击右上「刷新」从 npm 拉取版本列表'
      this.ccList.append(empty)
      this.ccPager.hidden = true
      return
    }

    const start = (this.ccPage - 1) * this.CC_PAGE_SIZE
    const slice = filtered.slice(start, start + this.CC_PAGE_SIZE)
    const frag = document.createDocumentFragment()
    for (const v of slice) frag.append(this.buildRow(v))
    this.ccList.append(frag)

    this.renderPager(totalPages)
  }

  private buildRow(version: string): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'cvrow'
    row.dataset.ver = version
    const installedInfo = this.ccInstalledMap.get(version)
    const isManagedActive = version === this.ccActiveVersion
    // 放宽：detected 且非 managed active 就算 external active —— 即使托管里也装了同版本，
    // 只要 claudePath 还指向自定义路径，仍然显示为「使用中·自定义路径」；托管副本作为备份
    const isExternalActive = !isManagedActive
      && !!this.ccDetectedVersion
      && version === this.ccDetectedVersion
    const isActive = isManagedActive || isExternalActive
    const isInstalled = !!installedInfo
    const isInstalling = version === this.ccInstallingVer
    if (isActive) row.classList.add('active')
    else if (isInstalled) row.classList.add('installed')
    if (isInstalling) row.classList.add('installing')

    const rail = document.createElement('span'); rail.className = 'cvrow-rail'; row.append(rail)

    const main = document.createElement('span'); main.className = 'cvrow-main'
    const num = document.createElement('span'); num.className = 'cvrow-num'; num.textContent = version
    main.append(num)

    const meta = document.createElement('span'); meta.className = 'cvrow-meta'
    if (isInstalling) {
      meta.textContent = this.formatInstallingMeta()
    } else if (isManagedActive) {
      meta.textContent = '使用中'
    } else if (isExternalActive) {
      // external active + 已托管 → 仍是"使用中·自定义路径"，尾巴加个小提示
      meta.textContent = isInstalled ? '使用中 · 自定义路径 · 已备份到托管' : '使用中 · 自定义路径'
    } else if (isInstalled) {
      meta.textContent = '已安装'; meta.title = installedInfo!.path
    }
    if (meta.textContent) main.append(meta)
    row.append(main)

    const act = document.createElement('span'); act.className = 'cvrow-act'
    if (isInstalling) {
      // 安装中 → 取消
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.className = 'cvrow-btn danger'
      cancel.addEventListener('click', () => void this.cancelInstall(version))
      act.append(cancel)
    } else if (isManagedActive) {
      // 托管使用中：禁止自删自切 —— 无按钮
    } else if (isExternalActive && !isInstalled) {
      // 使用中但没在托管：给「安装」，把当前版本备份到托管，方便以后切回
      const install = document.createElement('button'); install.type = 'button'; install.textContent = '安装'; install.className = 'cvrow-btn primary'
      install.title = '把当前版本装到托管目录一份，方便以后随时切回'
      install.disabled = !!this.ccInstallingVer
      install.addEventListener('click', () => this.confirmInstall(version))
      act.append(install)
    } else if (isExternalActive && isInstalled) {
      // 使用中且已在托管：启用 = 把 claudePath 切到托管副本；卸载 = 只删托管副本、不影响外部
      const use = document.createElement('button'); use.type = 'button'; use.textContent = '启用'; use.className = 'cvrow-btn primary'
      use.title = '把 claude 路径切换到托管副本'
      use.addEventListener('click', () => this.activateVersion(installedInfo!.path))
      const del = document.createElement('button'); del.type = 'button'; del.textContent = '卸载'; del.className = 'cvrow-btn danger'
      del.title = '仅删除托管副本，不影响当前正在使用的自定义路径'
      del.addEventListener('click', () => this.deleteVersion(version))
      act.append(use, del)
    } else if (isInstalled) {
      // 普通托管备用版本
      const use = document.createElement('button'); use.type = 'button'; use.textContent = '启用'; use.className = 'cvrow-btn primary'
      use.addEventListener('click', () => this.activateVersion(installedInfo!.path))
      const del = document.createElement('button'); del.type = 'button'; del.textContent = '卸载'; del.className = 'cvrow-btn danger'
      del.addEventListener('click', () => this.deleteVersion(version))
      act.append(use, del)
    } else {
      const install = document.createElement('button'); install.type = 'button'; install.textContent = '安装'; install.className = 'cvrow-btn primary'
      install.disabled = !!this.ccInstallingVer
      install.addEventListener('click', () => this.confirmInstall(version))
      act.append(install)
    }
    row.append(act)
    return row
  }

  private formatInstallingMeta(): string {
    const secs = Math.max(0, Math.floor((Date.now() - this.ccInstallStartTs) / 1000))
    const short = this.ccInstallPhase && this.ccInstallPhase.length > 60
      ? this.ccInstallPhase.slice(0, 60) + '…'
      : this.ccInstallPhase
    return `安装中 · ${secs}s${short ? ' · ' + short : ''}`
  }

  // 局部刷新：只重绘 installing 行的 meta，避免每 tick 整表重排
  private updateInstallingRow(): void {
    if (!this.ccInstallingVer) return
    const row = this.ccList.querySelector<HTMLDivElement>(`.cvrow[data-ver="${cssEscape(this.ccInstallingVer)}"]`)
    if (!row) return
    const meta = row.querySelector<HTMLSpanElement>('.cvrow-meta')
    if (meta) meta.textContent = this.formatInstallingMeta()
  }

  private renderPager(totalPages: number): void {
    this.ccPager.hidden = false
    this.ccPager.innerHTML = ''

    const prev = document.createElement('button')
    prev.type = 'button'; prev.className = 'cvpager-arrow'; prev.title = '上一页'
    prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>'
    prev.disabled = this.ccPage <= 1
    prev.addEventListener('click', () => { this.ccPage--; this.renderList() })

    const status = document.createElement('span'); status.className = 'cvpager-status'
    status.innerHTML = `第 <span class="cur">${this.ccPage}</span> / ${totalPages} 页`

    const next = document.createElement('button')
    next.type = 'button'; next.className = 'cvpager-arrow'; next.title = '下一页'
    next.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
    next.disabled = this.ccPage >= totalPages
    next.addEventListener('click', () => { this.ccPage++; this.renderList() })

    const spacer = document.createElement('span'); spacer.className = 'cvpager-spacer'

    // 使用中版本所在页 → 若不在本页，展示一个小跳转 chip（在本页时不显示，rail + meta 已足够）
    const curPage = this.pageOfCurrent()
    if (curPage > 0 && curPage !== this.ccPage) {
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'cvpager-jump'
      jump.title = `跳到第 ${curPage} 页`
      jump.textContent = '当前使用版本'
      jump.addEventListener('click', () => { this.ccPage = curPage; this.renderList() })
      this.ccPager.append(prev, status, spacer, jump, next)
    } else {
      this.ccPager.append(prev, status, spacer, next)
    }
  }

  private async activateVersion(path: string): Promise<void> {
    const cur = this.hooks.getSettings()
    if (cur.claudePath === path) return
    const next = { ...cur, claudePath: path }
    this.hooks.setSettings(next)
    // hooks.setSettings 走 300ms 去抖落盘 —— 但下面 refresh 立即通过 IPC 让主进程读磁盘
    // 拿 claudePath 判断哪版是 active。抢跑就会读到旧值 → UI 显示"没换"。
    // 这里显式 await 一次落盘（幂等，去抖的第二次写入也无副作用），确保 refresh 拿到新值。
    await window.term.saveSettings(next)
    await this.refresh(false)
  }

  private deleteVersion(version: string): void {
    confirmDialog({
      title: '卸载 CC 版本',
      message: `确定卸载 <b>v${version}</b>？此操作不可恢复。`,
      okLabel: '卸载',
      danger: true,
      onOk: async () => {
        const res = await window.term.ccUninstall(version)
        if (!res.ok) {
          this.setCcHint(`卸载失败：${res.error ?? '未知'}`, 'err')
          return
        }
        void this.refresh(false)
      }
    })
  }

  private confirmInstall(version: string): void {
    if (this.ccInstallingVer) return
    // 使用中·自定义路径的版本安装 → 语义是"备份到托管"，改一下措辞让用户明白目的
    const isBackup =
      !!this.ccDetectedVersion &&
      version === this.ccDetectedVersion &&
      !this.ccInstalledSet.has(version)
    const msg = isBackup
      ? `你现在正用着 <b>v${version}</b>（自定义路径），把它安装到托管一份作为备份？<br>` +
        `安装期间当前使用不受影响；装完后可通过「启用」在托管副本与自定义路径之间切换。`
      : `即将从 <b>npm 镜像</b> 安装 <b>v${version}</b>。<br>` +
        `安装过程中会调 npm 下载并解压依赖，可能耗时几十秒。<br>` +
        `安装中可以点「取消」中止。`
    confirmDialog({
      title: isBackup ? '备份到托管' : '安装 CC 版本',
      message: msg,
      okLabel: isBackup ? '备份' : '安装',
      danger: false,
      onOk: () => void this.installVersion(version)
    })
  }

  private async installVersion(version: string): Promise<void> {
    if (this.ccInstallingVer) return
    this.ccInstallingVer = version
    this.ccInstallStartTs = Date.now()
    this.ccInstallPhase = ''
    this.setCcHint('', '')
    this.renderList()
    // 每 700ms 局部刷新 installing 行的 meta（elapsed 秒计数）
    this.ccInstallTicker = window.setInterval(() => this.updateInstallingRow(), 700)
    try {
      const res = await window.term.ccInstall(version)
      if (!res.ok && res.error !== '已取消') {
        this.setCcHint(`安装失败：${res.error ?? '未知'}`, 'err')
      }
    } finally {
      if (this.ccInstallTicker !== null) {
        clearInterval(this.ccInstallTicker)
        this.ccInstallTicker = null
      }
      this.ccInstallingVer = ''
      this.ccInstallPhase = ''
      await this.refresh(false)
    }
  }

  private async cancelInstall(version: string): Promise<void> {
    const res = await window.term.ccInstallCancel(version)
    if (!res.ok) {
      this.setCcHint(`取消失败：${res.error ?? '未知'}`, 'err')
    }
    // 成功后 install() 会走 error='已取消' 分支 resolve，走 installVersion 的 finally 收尾
  }

  private setCcHint(text: string, kind: '' | 'ok' | 'err'): void {
    this.ccHint.textContent = text
    this.ccHint.classList.remove('ok', 'err')
    if (kind) this.ccHint.classList.add(kind)
  }

  private paintCursorActive(): void {
    for (const item of this.fCursorGroup.querySelectorAll<HTMLButtonElement>('.seg-item')) {
      item.classList.toggle('active', item.dataset.val === this.currentCursor)
    }
  }

  // 通用分段按钮：点击切换 active + 触发保存；选中值存在 data-val。
  private segVals = new Map<HTMLElement, string>()
  private initSeg(group: HTMLElement): void {
    for (const item of group.querySelectorAll<HTMLButtonElement>('.seg-item')) {
      item.addEventListener('click', () => {
        const v = item.dataset.val
        if (v == null) return
        this.setSeg(group, v)
        this.commitChange()
      })
    }
  }
  private setSeg(group: HTMLElement, v: string): void {
    this.segVals.set(group, v)
    for (const item of group.querySelectorAll<HTMLButtonElement>('.seg-item')) {
      item.classList.toggle('active', item.dataset.val === v)
    }
  }
  private getSeg(group: HTMLElement): string {
    return this.segVals.get(group) ?? ''
  }

  // arg = '' 视为"跟随 cc 默认"。用共享 MODEL_GROUPS 保证与左下芯片候选一致。
  private paintModelPicker(): void {
    const val = this.fDefaultModel.dataset.val ?? ''
    const label =
      val === ''
        ? FOLLOW_CC_LABEL
        : MODEL_GROUPS.flatMap((g) => g.rows).find((r) => r.arg === val)?.label ?? FOLLOW_CC_LABEL
    const muted = val === '' ? ' mute' : ''
    this.fDefaultModel.innerHTML =
      `<span class="picker-label${muted}">${label}</span>` +
      `<span class="picker-chev">${icon('chevron-down', { size: 14 })}</span>`
  }

  private openModelPicker(): void {
    const cur = this.fDefaultModel.dataset.val ?? ''
    const setVal = (v: string): void => {
      if ((this.fDefaultModel.dataset.val ?? '') === v) return
      this.fDefaultModel.dataset.val = v
      this.paintModelPicker()
      this.commitChange()
    }
    const items: import('./ui-helpers').CtxItem[] = [
      { label: FOLLOW_CC_LABEL, icon: cur === '' ? '✓' : '', act: () => setVal('') },
      { sep: true }
    ]
    MODEL_GROUPS.forEach((g, gi) => {
      if (gi > 0) items.push({ sep: true })
      items.push({ eyebrow: g.family })
      for (const r of g.rows) {
        items.push({
          label: r.label,
          icon: r.arg === cur ? '✓' : '',
          act: () => setVal(r.arg)
        })
      }
    })
    const r = this.fDefaultModel.getBoundingClientRect()
    // 菜单宽 ≈ picker 宽度，从下方展开；showCtxMenu 会自己夹进视口
    this.fDefaultModel.classList.add('open')
    showCtxMenu(items, r.left, r.bottom + 4, () => this.fDefaultModel.classList.remove('open'))
  }

  // 设置里勾了「禁止自动升级」但系统环境变量还没写（如默认勾选、从未触发过写入）→
  // 补写一次，保持设置与系统状态一致。
  private async ensureUpdConsistency(): Promise<void> {
    try {
      const cur = await window.term.readDisableAutoupdater()
      if (this.hooks.getSettings().disableAutoupdater && cur !== '1') {
        await this.syncSystemEnv(true)
      }
    } catch {}
  }

  private bindFromSettings(s: Settings): void {
    this.fFamily.value = s.font.family
    this.fSize.value = String(s.font.size)
    this.fLine.value = String(s.font.lineHeight)
    this.setSeg(this.fTheme, s.terminal.theme)
    this.setSeg(this.fAppTheme, s.appTheme)
    this.currentCursor = s.cursor.style
    this.paintCursorActive()
    this.fCursorBlink.checked = s.cursor.blink
    this.fScrollback.value = String(s.terminal.scrollback)
    this.fDefaultCC.checked = s.defaults.autoLaunchCC
    // 未知的 model arg 兜底到空（跟随 cc 默认）—— 老配置里存了已退役 id 时不至于白屏
    const known = new Set<string>(['', ...MODEL_GROUPS.flatMap((g) => g.rows.map((r) => r.arg))])
    this.fDefaultModel.dataset.val = known.has(s.defaults.model) ? s.defaults.model : ''
    this.paintModelPicker()
    this.fNpmReg.value = s.npmRegistry
    this.fDisableUpd.checked = s.disableAutoupdater
    this.setSeg(this.fDowngradeSec, String(s.statusDowngradeSec))
    this.fShowUsage.checked = s.showClaudeUsage
    this.fShowFloater.checked = s.showFloater
    this.lastDisableUpd = s.disableAutoupdater
  }

  private clamp(n: number, min: number, max: number, fb: number): number {
    if (!Number.isFinite(n)) return fb
    return Math.min(max, Math.max(min, n))
  }

  private commitChange(): void {
    const cur = this.hooks.getSettings()
    const next: Settings = {
      // 用 cur 打底，保留面板里没有的字段（lastUsedCwd / sidebarWidth /
      // sidebarCollapsed / savedCollapsed），否则它们会在每次保存时被抹掉。
      ...cur,
      version: 1,
      font: {
        family: this.fFamily.value.trim() || DEFAULT_SETTINGS.font.family,
        size: this.clamp(Number(this.fSize.value), 8, 40, cur.font.size),
        lineHeight: this.clamp(Number(this.fLine.value), 1.0, 2.0, cur.font.lineHeight)
      },
      cursor: {
        style: this.currentCursor || cur.cursor.style,
        blink: this.fCursorBlink.checked
      },
      terminal: {
        scrollback: this.clamp(Number(this.fScrollback.value), 100, 100000, cur.terminal.scrollback),
        theme: (this.getSeg(this.fTheme) as ThemePreset) || cur.terminal.theme
      },
      appTheme: (this.getSeg(this.fAppTheme) as AppTheme) || cur.appTheme,
      defaults: {
        // cwd 预填全靠 lastUsedCwd 自动记忆，设置面板不再提供手动默认路径
        cwd: cur.defaults.cwd,
        autoLaunchCC: this.fDefaultCC.checked,
        model: this.fDefaultModel.dataset.val ?? ''
      },
      // claudePath 由 CC 版本管理 / 首启自动检测维护，面板不直接编辑（...cur 已带上）
      npmRegistry: this.fNpmReg.value.trim() || DEFAULT_SETTINGS.npmRegistry,
      disableAutoupdater: this.fDisableUpd.checked,
      statusDowngradeSec: this.clamp(Number(this.getSeg(this.fDowngradeSec)), 1, 10, cur.statusDowngradeSec),
      showClaudeUsage: this.fShowUsage.checked,
      showFloater: this.fShowFloater.checked
    }
    this.hooks.setSettings(next)
    if (this.lastDisableUpd !== null && this.lastDisableUpd !== next.disableAutoupdater) {
      void this.syncSystemEnv(next.disableAutoupdater)
    }
    this.lastDisableUpd = next.disableAutoupdater
  }

  private async syncSystemEnv(enabled: boolean): Promise<void> {
    // 行为保留：写入/移除 Windows 用户环境变量；UI 上不再回显结果
    try { await window.term.applyDisableAutoupdater(enabled) } catch {}
  }
}
