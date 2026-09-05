import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  maskClaudeToken,
  type ClaudeAccountDetail,
  type ClaudeAccountsSnapshot
} from '../../../shared/claude-accounts'
import { confirmDialog, toast } from '../state/overlays'
import { icon } from '../svg-icons'
import { t } from '../i18n'

interface ClaudeAccountSectionProps {
  active: boolean
}

type DraftSource = ClaudeAccountDetail['source'] | 'new'

interface AccountDraft {
  id: string | null
  name: string
  authToken: string
  baseUrl: string
  source: DraftSource
  active: boolean
}

const EXTERNAL_KEY = '__current__'
const NEW_KEY = '__new__'

function emptyDraft(): AccountDraft {
  return {
    id: null,
    name: '',
    authToken: '',
    baseUrl: '',
    source: 'new',
    active: false
  }
}

function detailDraft(detail: ClaudeAccountDetail): AccountDraft {
  return {
    id: detail.id,
    name: detail.name,
    authToken: detail.authToken,
    baseUrl: detail.baseUrl,
    source: detail.source,
    active: detail.active
  }
}

function sameDraft(a: AccountDraft | null, b: AccountDraft | null): boolean {
  if (!a || !b) return a === b
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.authToken === b.authToken &&
    a.baseUrl === b.baseUrl &&
    a.source === b.source
  )
}

function baseUrlLabel(baseUrl: string): string {
  if (!baseUrl) return t('默认地址')
  try {
    const url = new URL(baseUrl)
    return url.host + (url.pathname === '/' ? '' : url.pathname)
  } catch {
    return baseUrl
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function selectionExists(key: string, snapshot: ClaudeAccountsSnapshot): boolean {
  if (key === NEW_KEY) return true
  if (key === EXTERNAL_KEY) return !!snapshot.currentUnsaved
  return snapshot.accounts.some((account) => account.id === key)
}

function defaultSelection(snapshot: ClaudeAccountsSnapshot): string {
  if (snapshot.activeAccountId) return snapshot.activeAccountId
  if (snapshot.currentUnsaved) return EXTERNAL_KEY
  return snapshot.accounts[0]?.id ?? NEW_KEY
}

export function ClaudeAccountSection({ active }: ClaudeAccountSectionProps) {
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>(NEW_KEY)
  const [draft, setDraft] = useState<AccountDraft | null>(null)
  const [original, setOriginal] = useState<AccountDraft | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const requestSeq = useRef(0)
  const snapshotRef = useRef(snapshot)
  const selectedKeyRef = useRef(selectedKey)
  snapshotRef.current = snapshot
  selectedKeyRef.current = selectedKey

  async function selectAccount(key: string): Promise<void> {
    const seq = ++requestSeq.current
    selectedKeyRef.current = key
    setSelectedKey(key)
    setError('')
    setHint('')
    setTokenVisible(key === NEW_KEY)

    if (key === NEW_KEY) {
      const next = emptyDraft()
      setDraft(next)
      setOriginal(next)
      setDetailLoading(false)
      return
    }

    setDetailLoading(true)
    setDraft(null)
    setOriginal(null)
    const loaded = await window.term.claudeAccountGet(key === EXTERNAL_KEY ? null : key)
    if (seq !== requestSeq.current) return
    setDetailLoading(false)
    if (!loaded.ok) {
      setError(t(loaded.error.message))
      return
    }
    const next = detailDraft(loaded.value)
    setDraft(next)
    setOriginal(next)
  }

  async function refreshAccounts(preferredKey?: string): Promise<void> {
    setLoading(true)
    setError('')
    const loaded = await window.term.claudeAccountsLoad()
    setLoading(false)
    if (!loaded.ok) {
      snapshotRef.current = null
      setSnapshot(null)
      setDraft(null)
      setOriginal(null)
      setError(t(loaded.error.message))
      return
    }

    const next = loaded.value
    const previous = snapshotRef.current ? selectedKeyRef.current : ''
    snapshotRef.current = next
    setSnapshot(next)
    const preferred = preferredKey ?? previous
    const key = selectionExists(preferred, next) ? preferred : defaultSelection(next)
    await selectAccount(key)
  }

  useEffect(() => {
    if (!active) return
    void refreshAccounts()
    return window.term.onClaudeAccountsChanged(() => {
      void refreshAccounts()
    })
  }, [active])

  function updateDraft(patch: Partial<AccountDraft>): void {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setError('')
    setHint('')
  }

  async function saveAccount(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!draft || busy) return
    setBusy(true)
    setError('')
    const saved = await window.term.claudeAccountSave({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      authToken: draft.authToken,
      baseUrl: draft.baseUrl
    })
    setBusy(false)
    if (!saved.ok) {
      setError(t(saved.error.message))
      return
    }

    snapshotRef.current = saved.value
    setSnapshot(saved.value)
    const selected =
      draft.id ??
      saved.value.accounts.find(
        (account) => account.name.toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase()
      )?.id
    const nextKey = selected ?? defaultSelection(saved.value)
    await selectAccount(nextKey)
    setTokenVisible(false)
    const nowActive = saved.value.activeAccountId === selected
    const message = nowActive ? t('账户已保存并同步') : t('账户已保存')
    setHint(message)
    toast(message)
  }

  async function activateAccount(): Promise<void> {
    if (!draft?.id || draft.active || busy) return
    setBusy(true)
    setError('')
    const activated = await window.term.claudeAccountActivate(draft.id)
    setBusy(false)
    if (!activated.ok) {
      setError(t(activated.error.message))
      return
    }

    snapshotRef.current = activated.value
    setSnapshot(activated.value)
    await selectAccount(draft.id)
    const message = t('已切换到「{0}」，新建或重新加载标签页后生效', draft.name)
    setHint(message)
    toast(message)
  }

  function requestDelete(): void {
    if (!draft?.id || busy) return
    const name = draft.name
    const wasActive = draft.active
    confirmDialog({
      title: t('删除账户'),
      message: wasActive
        ? t(
            '确定删除账户 <b>{0}</b>？<br>当前 Claude Code 配置仍会保留，但不再作为已保存账户显示。',
            escapeHtml(name)
          )
        : t('确定删除账户 <b>{0}</b>？此操作不可恢复。', escapeHtml(name)),
      okLabel: t('删除'),
      danger: true,
      onOk: () => {
        void (async () => {
          setBusy(true)
          setError('')
          const deleted = await window.term.claudeAccountDelete(draft.id!)
          setBusy(false)
          if (!deleted.ok) {
            setError(t(deleted.error.message))
            return
          }
          snapshotRef.current = deleted.value
          setSnapshot(deleted.value)
          const nextKey = defaultSelection(deleted.value)
          await selectAccount(nextKey)
          const message = t('账户「{0}」已删除', name)
          setHint(message)
          toast(message)
        })()
      }
    })
  }

  const activeName = snapshot?.activeAccountId
    ? snapshot.accounts.find((account) => account.id === snapshot.activeAccountId)?.name
    : null
  const dirty = !sameDraft(draft, original)
  const canSave =
    !!draft &&
    !!draft.name.trim() &&
    !!draft.authToken.trim() &&
    (dirty || draft.source !== 'saved') &&
    !busy
  const tokenValue = draft
    ? tokenVisible
      ? draft.authToken
      : maskClaudeToken(draft.authToken)
    : ''

  return (
    <section className="cc-account" data-testid="claude-account-section">
      <header className="cc-account-head" data-testid="claude-account-header">
        <div className="cc-account-title-wrap" data-testid="claude-account-title-wrap">
          <h3 data-testid="claude-account-title">{t('账户')}</h3>
          <span className="cc-account-current" data-testid="claude-account-current-status">
            {activeName
              ? t('当前：{0}', activeName)
              : snapshot?.currentUnsaved
                ? t('当前配置未保存')
                : t('未配置')}
          </span>
        </div>
        <button
          type="button"
          className="cc-account-icon-btn"
          title={t('新增账户')}
          aria-label={t('新增账户')}
          data-testid="claude-account-add-btn"
          disabled={busy}
          onClick={() => void selectAccount(NEW_KEY)}
          dangerouslySetInnerHTML={{ __html: icon('plus', { size: 14 }) }}
        />
      </header>

      {loading && !snapshot ? (
        <div className="cc-account-state" data-testid="claude-account-loading-state">
          {t('正在读取账户配置…')}
        </div>
      ) : null}

      {!loading && !snapshot && error ? (
        <div className="cc-account-state error" data-testid="claude-account-error-state">
          <span data-testid="claude-account-error-message">{error}</span>
          <button
            type="button"
            className="link-btn"
            data-testid="claude-account-retry-btn"
            onClick={() => void refreshAccounts()}
          >
            {t('重试')}
          </button>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div
            className="cc-account-list"
            role="listbox"
            aria-label={t('已保存账户')}
            data-testid="claude-account-list"
          >
            {snapshot.currentUnsaved ? (
              <div
                className={
                  'cc-account-item external' +
                  (selectedKey === EXTERNAL_KEY ? ' selected' : '')
                }
                data-testid="claude-account-list-item-current"
              >
                <button
                  type="button"
                  className="cc-account-item-main"
                  role="option"
                  aria-selected={selectedKey === EXTERNAL_KEY}
                  data-testid="claude-account-list-item-current-select-btn"
                  onClick={() => void selectAccount(EXTERNAL_KEY)}
                >
                  <span
                    className="cc-account-item-name"
                    data-testid="claude-account-list-item-current-name"
                  >
                    {t('当前配置')}
                  </span>
                  <span
                    className="cc-account-item-meta"
                    data-testid="claude-account-list-item-current-meta"
                  >
                    <span data-testid="claude-account-list-item-current-token">
                      {snapshot.currentUnsaved.tokenPreview || t('无 Token')}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span data-testid="claude-account-list-item-current-url">
                      {baseUrlLabel(snapshot.currentUnsaved.baseUrl)}
                    </span>
                  </span>
                </button>
                <span
                  className="cc-account-badge muted"
                  data-testid="claude-account-list-item-current-badge"
                >
                  {t('未保存')}
                </span>
              </div>
            ) : null}

            {snapshot.accounts.map((account) => {
              const itemTestId = `claude-account-list-item-${account.id}`
              return (
                <div
                  key={account.id}
                  className={
                    'cc-account-item' +
                    (selectedKey === account.id ? ' selected' : '') +
                    (account.active ? ' active' : '')
                  }
                  data-testid={itemTestId}
                >
                  <button
                    type="button"
                    className="cc-account-item-main"
                    role="option"
                    aria-selected={selectedKey === account.id}
                    data-testid={`${itemTestId}-select-btn`}
                    onClick={() => void selectAccount(account.id)}
                  >
                    <span
                      className="cc-account-item-name"
                      data-testid={`${itemTestId}-name`}
                    >
                      {account.name}
                    </span>
                    <span
                      className="cc-account-item-meta"
                      data-testid={`${itemTestId}-meta`}
                    >
                      <span data-testid={`${itemTestId}-token`}>{account.tokenPreview}</span>
                      <span aria-hidden="true">·</span>
                      <span data-testid={`${itemTestId}-url`}>
                        {baseUrlLabel(account.baseUrl)}
                      </span>
                    </span>
                  </button>
                  {account.active ? (
                    <span
                      className="cc-account-badge"
                      data-testid={`${itemTestId}-active-badge`}
                    >
                      {t('使用中')}
                    </span>
                  ) : null}
                </div>
              )
            })}

            {!snapshot.currentUnsaved && snapshot.accounts.length === 0 ? (
              <div className="cc-account-empty" data-testid="claude-account-empty-state">
                {t('暂无账户')}
              </div>
            ) : null}
          </div>

          {detailLoading ? (
            <div className="cc-account-state" data-testid="claude-account-detail-loading-state">
              {t('正在读取账户…')}
            </div>
          ) : draft ? (
            <form
              className="cc-account-form"
              autoComplete="off"
              data-testid="claude-account-form"
              onSubmit={(event) => void saveAccount(event)}
            >
              <div className="cc-account-field" data-testid="claude-account-name-field">
                <label htmlFor="cc-account-name" data-testid="claude-account-name-label">
                  {t('账户名称')}
                </label>
                <input
                  id="cc-account-name"
                  type="text"
                  maxLength={60}
                  value={draft.name}
                  placeholder={t('例如：工作账户')}
                  data-testid="claude-account-name-input"
                  disabled={busy}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </div>

              <div className="cc-account-field" data-testid="claude-account-token-field">
                <label htmlFor="cc-account-token" data-testid="claude-account-token-label">
                  Token
                </label>
                <div className="cc-account-secret" data-testid="claude-account-token-control">
                  <input
                    id="cc-account-token"
                    className="mono"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={tokenValue}
                    placeholder={t('输入 ANTHROPIC_AUTH_TOKEN')}
                    readOnly={!tokenVisible}
                    disabled={busy}
                    data-testid="claude-account-token-input"
                    onChange={(event) => {
                      if (tokenVisible) updateDraft({ authToken: event.target.value })
                    }}
                  />
                  <button
                    type="button"
                    className="cc-account-eye-btn"
                    title={tokenVisible ? t('隐藏 Token') : t('显示 Token')}
                    aria-label={tokenVisible ? t('隐藏 Token') : t('显示 Token')}
                    aria-pressed={tokenVisible}
                    data-testid="claude-account-token-visibility-btn"
                    disabled={busy}
                    onClick={() => setTokenVisible((visible) => !visible)}
                    dangerouslySetInnerHTML={{
                      __html: icon(tokenVisible ? 'eye-off' : 'eye', { size: 15 })
                    }}
                  />
                </div>
              </div>

              <div className="cc-account-field" data-testid="claude-account-url-field">
                <label htmlFor="cc-account-url" data-testid="claude-account-url-label">
                  Base URL
                </label>
                <input
                  id="cc-account-url"
                  className="mono"
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.baseUrl}
                  placeholder="https://api.anthropic.com"
                  data-testid="claude-account-url-input"
                  disabled={busy}
                  onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                />
              </div>

              <div className="cc-account-actions" data-testid="claude-account-form-actions">
                {draft.id ? (
                  <button
                    type="button"
                    className="cc-account-delete-btn"
                    title={t('删除账户')}
                    aria-label={t('删除账户')}
                    data-testid="claude-account-delete-btn"
                    disabled={busy}
                    onClick={requestDelete}
                    dangerouslySetInnerHTML={{ __html: icon('trash', { size: 14 }) }}
                  />
                ) : null}
                <span
                  className="cc-account-action-spacer"
                  aria-hidden="true"
                  data-testid="claude-account-action-spacer"
                />
                {draft.id && !draft.active ? (
                  <button
                    type="button"
                    className="cc-account-action-btn secondary"
                    data-testid="claude-account-activate-btn"
                    disabled={busy || dirty}
                    onClick={() => void activateAccount()}
                  >
                    <span
                      className="cc-account-action-icon"
                      aria-hidden="true"
                      data-testid="claude-account-activate-icon"
                      dangerouslySetInnerHTML={{
                        __html: icon('arrow-left-right', { size: 13 })
                      }}
                    />
                    <span data-testid="claude-account-activate-label">{t('切换')}</span>
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="cc-account-action-btn primary"
                  data-testid="claude-account-save-btn"
                  disabled={!canSave}
                >
                  <span
                    className="cc-account-action-icon"
                    aria-hidden="true"
                    data-testid="claude-account-save-icon"
                    dangerouslySetInnerHTML={{ __html: icon('save', { size: 13 }) }}
                  />
                  <span data-testid="claude-account-save-label">{t('保存')}</span>
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}

      {snapshot ? (
        <div
          className={'cc-account-hint' + (error ? ' error' : hint ? ' ok' : '')}
          role="status"
          data-testid="claude-account-status-message"
        >
          {error || hint}
        </div>
      ) : null}
    </section>
  )
}
