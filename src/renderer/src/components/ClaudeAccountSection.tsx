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

// 编辑弹窗：新建账户，或编辑某个已保存账户 / 当前未保存配置
interface EditorState {
  // null = 新建；'current' = 把当前 settings.json 配置存成账户；其余为已保存账户 id
  id: string | null
  origin: 'new' | 'saved' | 'current'
  name: string
  authToken: string
  baseUrl: string
}

const EXTERNAL_KEY = '__current__'

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

export function ClaudeAccountSection({ active }: ClaudeAccountSectionProps) {
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editorError, setEditorError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const editorSeq = useRef(0)

  async function refreshAccounts(): Promise<void> {
    setLoading(true)
    const loaded = await window.term.claudeAccountsLoad()
    setLoading(false)
    if (!loaded.ok) {
      setSnapshot(null)
      setError(t(loaded.error.message))
      return
    }
    setError('')
    setSnapshot(loaded.value)
  }

  useEffect(() => {
    if (!active) return
    void refreshAccounts()
    return window.term.onClaudeAccountsChanged(() => {
      void refreshAccounts()
    })
  }, [active])

  // 面板关闭时收起下拉，避免下次打开残留展开态
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  // 点外部 / Esc 收起下拉（编辑弹窗自己处理 Esc）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // 选中即切换：已经在用的账户只收起下拉，不重复写 settings.json
  async function pickAccount(id: string): Promise<void> {
    setOpen(false)
    if (busy) return
    const account = snapshot?.accounts.find((item) => item.id === id)
    if (!account || account.active) return
    setBusy(true)
    const activated = await window.term.claudeAccountActivate(id)
    setBusy(false)
    if (!activated.ok) {
      const message = t(activated.error.message)
      setError(message)
      toast(message)
      return
    }
    setError('')
    setSnapshot(activated.value)
    toast(t('已切换到「{0}」', account.name))
  }

  function openCreate(): void {
    editorSeq.current++
    setOpen(false)
    setEditorError('')
    setTokenVisible(true)
    setEditorLoading(false)
    setEditor({ id: null, origin: 'new', name: '', authToken: '', baseUrl: '' })
  }

  // 编辑：Token 明文只在打开弹窗时按 id 单独取，一直不进列表快照
  async function openEdit(key: string): Promise<void> {
    const seq = ++editorSeq.current
    setOpen(false)
    setEditorError('')
    setTokenVisible(false)
    setEditorLoading(true)
    setEditor({
      id: key === EXTERNAL_KEY ? null : key,
      origin: key === EXTERNAL_KEY ? 'current' : 'saved',
      name: '',
      authToken: '',
      baseUrl: ''
    })
    const loaded = await window.term.claudeAccountGet(key === EXTERNAL_KEY ? null : key)
    if (seq !== editorSeq.current) return
    setEditorLoading(false)
    if (!loaded.ok) {
      const message = t(loaded.error.message)
      setEditor(null)
      setError(message)
      toast(message)
      return
    }
    const detail: ClaudeAccountDetail = loaded.value
    setEditor({
      id: detail.id,
      origin: detail.source === 'current' ? 'current' : 'saved',
      name: detail.name,
      authToken: detail.authToken,
      baseUrl: detail.baseUrl
    })
  }

  function closeEditor(): void {
    editorSeq.current++
    setEditor(null)
    setEditorError('')
    setEditorLoading(false)
    setTokenVisible(false)
  }

  function updateEditor(patch: Partial<EditorState>): void {
    setEditor((current) => (current ? { ...current, ...patch } : current))
    setEditorError('')
  }

  async function submitEditor(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || busy || editorLoading) return
    setBusy(true)
    const saved = await window.term.claudeAccountSave({
      ...(editor.id ? { id: editor.id } : {}),
      name: editor.name,
      authToken: editor.authToken,
      baseUrl: editor.baseUrl
    })
    setBusy(false)
    if (!saved.ok) {
      setEditorError(t(saved.error.message))
      return
    }
    setSnapshot(saved.value)
    setError('')
    closeEditor()
    const savedId =
      editor.id ??
      saved.value.accounts.find(
        (item) => item.name.toLocaleLowerCase() === editor.name.trim().toLocaleLowerCase()
      )?.id
    toast(saved.value.activeAccountId === savedId ? t('账户已保存并同步') : t('账户已保存'))
  }

  function requestDelete(id: string, name: string, wasActive: boolean): void {
    if (busy) return
    setOpen(false)
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
          const deleted = await window.term.claudeAccountDelete(id)
          setBusy(false)
          if (!deleted.ok) {
            const message = t(deleted.error.message)
            setError(message)
            toast(message)
            return
          }
          setError('')
          setSnapshot(deleted.value)
          toast(t('账户「{0}」已删除', name))
        })()
      }
    })
  }

  const activeAccount = snapshot?.activeAccountId
    ? snapshot.accounts.find((account) => account.id === snapshot.activeAccountId) ?? null
    : null
  const triggerLabel = activeAccount
    ? activeAccount.name
    : snapshot?.currentUnsaved
      ? t('当前配置（未保存）')
      : t('未配置')
  const triggerMeta = activeAccount
    ? `${activeAccount.tokenPreview} · ${baseUrlLabel(activeAccount.baseUrl)}`
    : snapshot?.currentUnsaved
      ? `${snapshot.currentUnsaved.tokenPreview || t('无 Token')} · ${baseUrlLabel(
          snapshot.currentUnsaved.baseUrl
        )}`
      : ''
  const canSubmit =
    !!editor && !!editor.name.trim() && !!editor.authToken.trim() && !busy && !editorLoading

  return (
    <section className="cc-account" data-testid="claude-account-section">
      <header className="cc-account-head" data-testid="claude-account-header">
        <h3 className="cc-account-title" data-testid="claude-account-title">
          {t('账户')}
        </h3>
      </header>

      {loading && !snapshot ? (
        <div className="cc-account-state" data-testid="claude-account-loading-state">
          {t('正在读取账户配置…')}
        </div>
      ) : null}

      {!loading && !snapshot ? (
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
        <div className="cc-account-select" ref={rootRef} data-testid="claude-account-select">
          <button
            type="button"
            className={'cc-account-trigger' + (open ? ' open' : '')}
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={busy}
            data-testid="claude-account-select-trigger"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="cc-account-trigger-text">
              <span
                className="cc-account-trigger-name"
                data-testid="claude-account-select-trigger-name"
              >
                {triggerLabel}
              </span>
              {triggerMeta ? (
                <span
                  className="cc-account-trigger-meta"
                  data-testid="claude-account-select-trigger-meta"
                >
                  {triggerMeta}
                </span>
              ) : null}
            </span>
            <span
              className="cc-account-trigger-caret"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: icon('chevron-down', { size: 14 }) }}
            />
          </button>

          {open ? (
            <div
              className="cc-account-menu"
              role="listbox"
              aria-label={t('已保存账户')}
              data-testid="claude-account-menu"
            >
              <div className="cc-account-menu-scroll" data-testid="claude-account-menu-scroll">
                {snapshot.currentUnsaved ? (
                  <div
                    className="cc-account-option current"
                    data-testid="claude-account-option-current"
                  >
                    <button
                      type="button"
                      className="cc-account-option-main"
                      role="option"
                      aria-selected={!snapshot.activeAccountId}
                      data-testid="claude-account-option-current-select-btn"
                      onClick={() => setOpen(false)}
                    >
                      <span
                        className="cc-account-option-name"
                        data-testid="claude-account-option-current-name"
                      >
                        {t('当前配置（未保存）')}
                      </span>
                      <span
                        className="cc-account-option-meta"
                        data-testid="claude-account-option-current-meta"
                      >
                        {`${snapshot.currentUnsaved.tokenPreview || t('无 Token')} · ${baseUrlLabel(
                          snapshot.currentUnsaved.baseUrl
                        )}`}
                      </span>
                    </button>
                    <span className="cc-account-option-ops">
                      <button
                        type="button"
                        className="cc-account-op-btn"
                        title={t('保存为账户')}
                        aria-label={t('保存为账户')}
                        data-testid="claude-account-option-current-edit-btn"
                        disabled={busy}
                        onClick={() => void openEdit(EXTERNAL_KEY)}
                        dangerouslySetInnerHTML={{ __html: icon('edit', { size: 13 }) }}
                      />
                    </span>
                  </div>
                ) : null}

                {snapshot.accounts.map((account) => {
                  const testId = `claude-account-option-${account.id}`
                  return (
                    <div
                      key={account.id}
                      className={'cc-account-option' + (account.active ? ' active' : '')}
                      data-testid={testId}
                    >
                      <button
                        type="button"
                        className="cc-account-option-main"
                        role="option"
                        aria-selected={account.active}
                        data-testid={`${testId}-select-btn`}
                        disabled={busy}
                        onClick={() => void pickAccount(account.id)}
                      >
                        <span
                          className="cc-account-option-name"
                          data-testid={`${testId}-name`}
                        >
                          {account.name}
                        </span>
                        <span
                          className="cc-account-option-meta"
                          data-testid={`${testId}-meta`}
                        >
                          {`${account.tokenPreview} · ${baseUrlLabel(account.baseUrl)}`}
                        </span>
                      </button>
                      <span className="cc-account-option-ops">
                        <button
                          type="button"
                          className="cc-account-op-btn"
                          title={t('编辑账户')}
                          aria-label={t('编辑账户')}
                          data-testid={`${testId}-edit-btn`}
                          disabled={busy}
                          onClick={() => void openEdit(account.id)}
                          dangerouslySetInnerHTML={{ __html: icon('edit', { size: 13 }) }}
                        />
                        <button
                          type="button"
                          className="cc-account-op-btn danger"
                          title={t('删除账户')}
                          aria-label={t('删除账户')}
                          data-testid={`${testId}-delete-btn`}
                          disabled={busy}
                          onClick={() => requestDelete(account.id, account.name, account.active)}
                          dangerouslySetInnerHTML={{ __html: icon('trash', { size: 13 }) }}
                        />
                      </span>
                    </div>
                  )
                })}

                {!snapshot.currentUnsaved && snapshot.accounts.length === 0 ? (
                  <div className="cc-account-empty" data-testid="claude-account-empty-state">
                    {t('暂无账户')}
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="cc-account-add-option"
                data-testid="claude-account-add-btn"
                disabled={busy}
                onClick={openCreate}
              >
                <span
                  className="cc-account-add-icon"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: icon('plus', { size: 13 }) }}
                />
                <span data-testid="claude-account-add-label">{t('新增账户')}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {snapshot && error ? (
        <div
          className="cc-account-hint error"
          role="status"
          data-testid="claude-account-status-message"
        >
          {error}
        </div>
      ) : null}

      {editor ? (
        <div
          className="scrim cc-account-scrim"
          data-testid="claude-account-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor()
          }}
        >
          <form
            className="modal cc-account-modal"
            role="dialog"
            aria-modal="true"
            aria-label={editor.origin === 'saved' ? t('编辑账户') : t('新增账户')}
            autoComplete="off"
            data-testid="claude-account-editor-dialog"
            onSubmit={(event) => void submitEditor(event)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              closeEditor()
            }}
          >
            <h2 data-testid="claude-account-editor-title">
              {editor.origin === 'saved' ? t('编辑账户') : t('新增账户')}
            </h2>

            {editorLoading ? (
              <div className="cc-account-state" data-testid="claude-account-editor-loading">
                {t('正在读取账户…')}
              </div>
            ) : (
              <>
                <div className="cc-account-field" data-testid="claude-account-name-field">
                  <label htmlFor="cc-account-name" data-testid="claude-account-name-label">
                    {t('账户名称')}
                  </label>
                  <input
                    id="cc-account-name"
                    type="text"
                    maxLength={60}
                    autoFocus
                    value={editor.name}
                    placeholder={t('例如：工作账户')}
                    data-testid="claude-account-name-input"
                    disabled={busy}
                    onChange={(event) => updateEditor({ name: event.target.value })}
                  />
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
                    value={editor.baseUrl}
                    placeholder="https://api.anthropic.com"
                    data-testid="claude-account-url-input"
                    disabled={busy}
                    onChange={(event) => updateEditor({ baseUrl: event.target.value })}
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
                      value={tokenVisible ? editor.authToken : maskClaudeToken(editor.authToken)}
                      placeholder={t('输入 ANTHROPIC_AUTH_TOKEN')}
                      readOnly={!tokenVisible}
                      disabled={busy}
                      data-testid="claude-account-token-input"
                      onChange={(event) => {
                        if (tokenVisible) updateEditor({ authToken: event.target.value })
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
              </>
            )}

            <div
              className="cc-account-modal-error"
              role="status"
              data-testid="claude-account-editor-error"
            >
              {editorError}
            </div>

            <div className="actions" data-testid="claude-account-editor-actions">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="claude-account-editor-cancel-btn"
                onClick={closeEditor}
              >
                {t('取消')}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                data-testid="claude-account-save-btn"
                disabled={!canSubmit}
              >
                {t('保存')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  )
}
