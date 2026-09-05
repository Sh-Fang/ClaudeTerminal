export type ClaudeAccountErrorCode =
  | 'INVALID_ACCOUNTS_FILE'
  | 'INVALID_CLAUDE_SETTINGS'
  | 'INVALID_ENV'
  | 'INVALID_VALUE'
  | 'NAME_EXISTS'
  | 'NOT_FOUND'
  | 'DECRYPT_FAILED'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL'
  | 'IO_ERROR'

export interface ClaudeAccountSummary {
  id: string
  name: string
  tokenPreview: string
  baseUrl: string
  active: boolean
}

export interface ClaudeCurrentAccountSummary {
  tokenPreview: string
  baseUrl: string
}

export interface ClaudeAccountsSnapshot {
  accounts: ClaudeAccountSummary[]
  activeAccountId: string | null
  currentUnsaved: ClaudeCurrentAccountSummary | null
}

export interface ClaudeAccountDetail {
  id: string | null
  name: string
  authToken: string
  baseUrl: string
  source: 'saved' | 'current'
  active: boolean
}

export interface SaveClaudeAccountInput {
  id?: string
  name: string
  authToken: string
  baseUrl: string
}

export type ClaudeAccountResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code: ClaudeAccountErrorCode
        message: string
      }
    }

export function maskClaudeToken(token: string): string {
  if (!token) return ''
  if (token.length <= 4) return '•'.repeat(token.length)
  if (token.length <= 10) return `${token.slice(0, 2)}••••${token.slice(-2)}`
  return `${token.slice(0, 6)}••••••${token.slice(-4)}`
}
