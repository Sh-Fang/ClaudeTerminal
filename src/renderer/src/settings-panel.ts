import { DEFAULT_SETTINGS, type Settings, type ThemePreset, type CursorStyle } from './themes'

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
  private fTheme = document.getElementById('set-theme') as HTMLSelectElement
  private fCursorStyle = document.getElementById('set-cursor-style') as HTMLSelectElement
  private fCursorBlink = document.getElementById('set-cursor-blink') as HTMLInputElement
  private fScrollback = document.getElementById('set-scrollback') as HTMLInputElement
  private fDefaultCwd = document.getElementById('set-default-cwd') as HTMLInputElement
  private fDefaultCC = document.getElementById('set-default-cc') as HTMLInputElement
  private fClaudePath = document.getElementById('set-claude-path') as HTMLInputElement
  private fDisableUpd = document.getElementById('set-disable-update') as HTMLInputElement
  private detectBtn = document.getElementById('set-claude-detect') as HTMLButtonElement
  private updHint = document.getElementById('set-disable-update-status') as HTMLDivElement
  private upUpdHintTimer: number | null = null
  private lastDisableUpd: boolean | null = null

  constructor(private hooks: SettingsPanelHooks) {
    this.btn.addEventListener('click', () => this.open())
    this.closeBtn.addEventListener('click', () => this.close())
    this.resetBtn.addEventListener('click', () => {
      this.bindFromSettings(DEFAULT_SETTINGS)
      this.commitChange()
    })
    this.scrim.addEventListener('click', (e) => {
      if (e.target === this.scrim) this.close()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.scrim.hidden) this.close()
    })

    // 各字段统一监听：input 实时改、change 兜底
    const live = [this.fFamily, this.fSize, this.fLine, this.fScrollback, this.fDefaultCwd, this.fClaudePath]
    const changeOnly = [this.fTheme, this.fCursorStyle, this.fCursorBlink, this.fDefaultCC, this.fDisableUpd]
    this.detectBtn.addEventListener('click', () => void this.runDetect())
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
    void this.refreshUpdHint()
    this.scrim.hidden = false
  }

  private async refreshUpdHint(): Promise<void> {
    try {
      const cur = await window.term.readDisableAutoupdater()
      if (cur === '1') {
        this.updHint.textContent = '✓ 已在 Windows 用户环境变量中设置（所有新启动的 cc 都生效）'
        this.updHint.className = 'set-hint ok'
      } else if (cur === null) {
        this.updHint.textContent = '未在系统环境变量中设置'
        this.updHint.className = 'set-hint'
      } else {
        this.updHint.textContent = `系统中已设为 "${cur}"（非 1）— 注意已有冲突值`
        this.updHint.className = 'set-hint warn'
      }
    } catch {
      this.updHint.textContent = ''
      this.updHint.className = 'set-hint'
    }
  }
  private flashHint(text: string, ok: boolean): void {
    this.updHint.textContent = text
    this.updHint.className = ok ? 'set-hint ok' : 'set-hint warn'
    if (this.upUpdHintTimer) window.clearTimeout(this.upUpdHintTimer)
    this.upUpdHintTimer = window.setTimeout(() => void this.refreshUpdHint(), 1800)
  }
  close(): void {
    this.scrim.hidden = true
  }

  private bindFromSettings(s: Settings): void {
    this.fFamily.value = s.font.family
    this.fSize.value = String(s.font.size)
    this.fLine.value = String(s.font.lineHeight)
    this.fTheme.value = s.terminal.theme
    this.fCursorStyle.value = s.cursor.style
    this.fCursorBlink.checked = s.cursor.blink
    this.fScrollback.value = String(s.terminal.scrollback)
    this.fDefaultCwd.value = s.defaults.cwd
    this.fDefaultCC.checked = s.defaults.autoLaunchCC
    this.fClaudePath.value = s.claudePath
    this.fDisableUpd.checked = s.disableAutoupdater
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
      version: 1,
      font: {
        family: this.fFamily.value.trim() || DEFAULT_SETTINGS.font.family,
        size: this.clamp(Number(this.fSize.value), 8, 40, cur.font.size),
        lineHeight: this.clamp(Number(this.fLine.value), 1.0, 2.0, cur.font.lineHeight)
      },
      cursor: {
        style: (this.fCursorStyle.value as CursorStyle) || cur.cursor.style,
        blink: this.fCursorBlink.checked
      },
      terminal: {
        scrollback: this.clamp(Number(this.fScrollback.value), 100, 100000, cur.terminal.scrollback),
        theme: (this.fTheme.value as ThemePreset) || cur.terminal.theme
      },
      defaults: {
        cwd: this.fDefaultCwd.value,
        autoLaunchCC: this.fDefaultCC.checked
      },
      claudePath: this.fClaudePath.value.trim(),
      disableAutoupdater: this.fDisableUpd.checked
    }
    this.hooks.setSettings(next)
    // 只在勾选状态发生翻转时去操作注册表，避免重复 setx
    if (this.lastDisableUpd !== null && this.lastDisableUpd !== next.disableAutoupdater) {
      void this.syncSystemEnv(next.disableAutoupdater)
    }
    this.lastDisableUpd = next.disableAutoupdater
  }

  private async syncSystemEnv(enabled: boolean): Promise<void> {
    this.updHint.textContent = enabled ? '正在写入用户环境变量…' : '正在移除用户环境变量…'
    this.updHint.className = 'set-hint'
    const res = await window.term.applyDisableAutoupdater(enabled)
    if (res.ok) {
      this.flashHint(enabled ? '✓ 已写入系统环境变量' : '✓ 已从系统环境变量移除', true)
    } else {
      this.flashHint(`✗ 操作失败：${res.message ?? '未知错误'}`, false)
    }
  }
}
