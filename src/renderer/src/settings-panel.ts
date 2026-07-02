import { DEFAULT_SETTINGS, type Settings, type ThemePreset, type CursorStyle } from './themes'
import { bindScrimDismiss, showCtxMenu } from './ui-helpers'
import { icon } from './svg-icons'
import { MODEL_GROUPS } from './session-info'

const FOLLOW_CC_LABEL = '跟随 cc 默认'

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
  private fCursorGroup = document.getElementById('set-cursor-style') as HTMLDivElement
  private fCursorBlink = document.getElementById('set-cursor-blink') as HTMLInputElement
  private fScrollback = document.getElementById('set-scrollback') as HTMLInputElement
  private fDefaultCwd = document.getElementById('set-default-cwd') as HTMLInputElement
  private fDefaultCC = document.getElementById('set-default-cc') as HTMLInputElement
  private fClaudePath = document.getElementById('set-claude-path') as HTMLInputElement
  private fDefaultModel = document.getElementById('set-default-model') as HTMLButtonElement
  private fDisableUpd = document.getElementById('set-disable-update') as HTMLInputElement
  private fDowngradeSec = document.getElementById('set-downgrade-sec') as HTMLDivElement
  private fConfirmClose = document.getElementById('set-confirm-close') as HTMLInputElement
  private fShowUsage = document.getElementById('set-show-usage') as HTMLInputElement
  private fShowFloater = document.getElementById('set-show-floater') as HTMLInputElement
  private detectBtn = document.getElementById('set-claude-detect') as HTMLButtonElement
  private pickCwdBtn = document.getElementById('set-default-cwd-pick') as HTMLButtonElement
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
      this.bindFromSettings(DEFAULT_SETTINGS)
      this.commitChange()
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
    this.initSeg(this.fDowngradeSec)
    this.fDefaultModel.addEventListener('click', (e) => {
      e.stopPropagation() // 挡掉 ui-helpers 里 document.click 关 ctx 的兜底
      this.openModelPicker()
    })

    const live = [this.fFamily, this.fSize, this.fLine, this.fScrollback, this.fDefaultCwd, this.fClaudePath]
    const changeOnly = [this.fCursorBlink, this.fDefaultCC, this.fDisableUpd, this.fConfirmClose, this.fShowUsage, this.fShowFloater]
    this.detectBtn.addEventListener('click', () => void this.runDetect())
    this.pickCwdBtn.addEventListener('click', () => void this.pickDefaultCwd())
    for (const el of live) {
      el.addEventListener('input', () => this.commitChange())
      el.addEventListener('change', () => this.commitChange())
    }
    for (const el of changeOnly) {
      el.addEventListener('change', () => this.commitChange())
    }
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

  private async pickDefaultCwd(): Promise<void> {
    const cur = this.fDefaultCwd.value.trim()
    const picked = await window.term.pickDirectory(cur || undefined)
    if (picked) {
      this.fDefaultCwd.value = picked
      this.commitChange()
    }
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
    this.currentCursor = s.cursor.style
    this.paintCursorActive()
    this.fCursorBlink.checked = s.cursor.blink
    this.fScrollback.value = String(s.terminal.scrollback)
    this.fDefaultCwd.value = s.lastUsedCwd || s.defaults.cwd
    this.fDefaultCC.checked = s.defaults.autoLaunchCC
    // 未知的 model arg 兜底到空（跟随 cc 默认）—— 老配置里存了已退役 id 时不至于白屏
    const known = new Set<string>(['', ...MODEL_GROUPS.flatMap((g) => g.rows.map((r) => r.arg))])
    this.fDefaultModel.dataset.val = known.has(s.defaults.model) ? s.defaults.model : ''
    this.paintModelPicker()
    this.fClaudePath.value = s.claudePath
    this.fDisableUpd.checked = s.disableAutoupdater
    this.setSeg(this.fDowngradeSec, String(s.statusDowngradeSec))
    this.fConfirmClose.checked = s.confirmCloseUnsaved
    this.fShowUsage.checked = s.showClaudeUsage
    this.fShowFloater.checked = s.showFloater
    this.lastDisableUpd = s.disableAutoupdater
  }

  private async runDetect(): Promise<void> {
    const old = this.detectBtn.textContent
    this.detectBtn.disabled = true
    this.detectBtn.textContent = '检测中…'
    try {
      const path = await window.term.claudeDetect()
      if (path) {
        this.fClaudePath.value = path
        this.commitChange()
        this.detectBtn.textContent = '已填入 ✓'
      } else {
        this.detectBtn.textContent = '没找到'
      }
    } catch {
      this.detectBtn.textContent = '检测失败'
    } finally {
      setTimeout(() => {
        this.detectBtn.textContent = old ?? '自动检测'
        this.detectBtn.disabled = false
      }, 1600)
    }
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
      defaults: {
        cwd: this.fDefaultCwd.value,
        autoLaunchCC: this.fDefaultCC.checked,
        model: this.fDefaultModel.dataset.val ?? ''
      },
      claudePath: this.fClaudePath.value.trim(),
      disableAutoupdater: this.fDisableUpd.checked,
      statusDowngradeSec: this.clamp(Number(this.getSeg(this.fDowngradeSec)), 1, 5, cur.statusDowngradeSec),
      confirmCloseUnsaved: this.fConfirmClose.checked,
      showClaudeUsage: this.fShowUsage.checked,
      showFloater: this.fShowFloater.checked,
      // 「默认新建分组路径」框即代表下次预填，写回时同步 lastUsedCwd 让它立即生效
      lastUsedCwd: this.fDefaultCwd.value
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
