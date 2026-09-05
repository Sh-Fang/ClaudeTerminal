import { app, safeStorage } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { maskClaudeToken } from '../shared/claude-accounts'
import type {
  ClaudeAccountDetail,
  ClaudeAccountErrorCode,
  ClaudeAccountResult,
  ClaudeAccountsSnapshot,
  SaveClaudeAccountInput
} from '../shared/claude-accounts'

const AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL'
const STORE_VERSION = 1
const MAX_ACCOUNTS = 50
const MAX_NAME_LENGTH = 60
const MAX_TOKEN_LENGTH = 65536
const MAX_URL_LENGTH = 2048

type JsonObject = Record<string, unknown>

type StoredSecret =
  | { kind: 'safe-storage'; value: string }
  | { kind: 'plain-base64'; value: string }

interface StoredClaudeAccount {
  id: string
  name: string
  authToken: StoredSecret
  baseUrl: string
  createdAt: string
  updatedAt: string
}

interface ClaudeAccountStore {
  version: 1
  preferredActiveId: string | null
  accounts: StoredClaudeAccount[]
}

interface DecryptedClaudeAccount extends Omit<StoredClaudeAccount, 'authToken'> {
  authToken: string
}

interface ClaudeSettingsState {
  root: JsonObject
  env: JsonObject
  authToken: string
  baseUrl: string
}

class ClaudeAccountError extends Error {
  constructor(
    readonly code: ClaudeAccountErrorCode,
    message: string
  ) {
    super(message)
  }
}

function accountStorePath(): string {
  return join(app.getPath('userData'), 'claude-accounts.json')
}

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asIoError(error: unknown, fallback: string): ClaudeAccountError {
  if (error instanceof ClaudeAccountError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') {
    return new ClaudeAccountError('PERMISSION_DENIED', '没有权限读写配置文件')
  }
  if (code === 'ENOSPC') {
    return new ClaudeAccountError('DISK_FULL', '磁盘空间不足，无法保存配置')
  }
  return new ClaudeAccountError('IO_ERROR', fallback)
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const nonce = randomBytes(6).toString('hex')
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${nonce}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw asIoError(error, '保存配置文件失败')
  }
}

function parseStoredSecret(value: unknown): StoredSecret | null {
  if (!isObject(value) || typeof value.value !== 'string') return null
  if (value.kind === 'safe-storage' || value.kind === 'plain-base64') {
    return { kind: value.kind, value: value.value }
  }
  return null
}

function readAccountStore(): ClaudeAccountStore {
  const path = accountStorePath()
  if (!existsSync(path)) {
    return { version: STORE_VERSION, preferredActiveId: null, accounts: [] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    const ioCode = (error as NodeJS.ErrnoException)?.code
    if (ioCode) throw asIoError(error, '读取账户配置失败')
    throw new ClaudeAccountError('INVALID_ACCOUNTS_FILE', '账户配置文件格式错误')
  }
  if (!isObject(raw) || raw.version !== STORE_VERSION || !Array.isArray(raw.accounts)) {
    throw new ClaudeAccountError('INVALID_ACCOUNTS_FILE', '账户配置文件格式错误')
  }

  const ids = new Set<string>()
  const accounts: StoredClaudeAccount[] = raw.accounts.map((item) => {
    if (!isObject(item)) {
      throw new ClaudeAccountError('INVALID_ACCOUNTS_FILE', '账户配置文件包含无效数据')
    }
    const authToken = parseStoredSecret(item.authToken)
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name ||
      !authToken ||
      typeof item.baseUrl !== 'string' ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      throw new ClaudeAccountError('INVALID_ACCOUNTS_FILE', '账户配置文件包含无效数据')
    }
    ids.add(item.id)
    return {
      id: item.id,
      name: item.name,
      authToken,
      baseUrl: item.baseUrl,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
  })

  const preferredActiveId =
    typeof raw.preferredActiveId === 'string' && ids.has(raw.preferredActiveId)
      ? raw.preferredActiveId
      : null
  return { version: STORE_VERSION, preferredActiveId, accounts }
}

function writeAccountStore(store: ClaudeAccountStore): void {
  writeJsonAtomic(accountStorePath(), store)
}

function encryptToken(token: string): StoredSecret {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        kind: 'safe-storage',
        value: safeStorage.encryptString(token).toString('base64')
      }
    }
    return {
      kind: 'plain-base64',
      value: Buffer.from(token, 'utf8').toString('base64')
    }
  } catch {
    throw new ClaudeAccountError('IO_ERROR', '加密 Token 失败')
  }
}

function decryptToken(secret: StoredSecret): string {
  try {
    const data = Buffer.from(secret.value, 'base64')
    return secret.kind === 'safe-storage'
      ? safeStorage.decryptString(data)
      : data.toString('utf8')
  } catch {
    throw new ClaudeAccountError('DECRYPT_FAILED', '无法读取已保存的 Token')
  }
}

function decryptAccounts(store: ClaudeAccountStore): DecryptedClaudeAccount[] {
  return store.accounts.map((account) => ({
    ...account,
    authToken: decryptToken(account.authToken)
  }))
}

function readEnvString(env: JsonObject, key: string): string {
  const entry =
    Object.entries(env).find(([name]) => name === key) ??
    Object.entries(env).find(([name]) => name.toUpperCase() === key)
  if (!entry) return ''
  if (typeof entry[1] !== 'string') {
    throw new ClaudeAccountError('INVALID_ENV', `${key} 必须是字符串`)
  }
  return entry[1]
}

function readClaudeSettings(): ClaudeSettingsState {
  const path = claudeSettingsPath()
  if (!existsSync(path)) {
    return { root: {}, env: {}, authToken: '', baseUrl: '' }
  }

  let root: unknown
  try {
    root = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    const ioCode = (error as NodeJS.ErrnoException)?.code
    if (ioCode) throw asIoError(error, '读取 Claude Code 配置失败')
    throw new ClaudeAccountError(
      'INVALID_CLAUDE_SETTINGS',
      'Claude Code settings.json 格式错误，未执行写入'
    )
  }
  if (!isObject(root)) {
    throw new ClaudeAccountError(
      'INVALID_CLAUDE_SETTINGS',
      'Claude Code settings.json 顶层必须是对象'
    )
  }
  const envValue = root.env
  if (envValue !== undefined && !isObject(envValue)) {
    throw new ClaudeAccountError('INVALID_ENV', 'Claude Code settings.json 的 env 必须是对象')
  }
  const env = envValue ?? {}
  return {
    root,
    env,
    authToken: readEnvString(env, AUTH_TOKEN_KEY),
    baseUrl: readEnvString(env, BASE_URL_KEY)
  }
}

function updateClaudeSettings(authToken: string, baseUrl: string): ClaudeSettingsState {
  const current = readClaudeSettings()
  const env: JsonObject = { ...current.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (upper === AUTH_TOKEN_KEY || upper === BASE_URL_KEY) delete env[key]
  }
  env[AUTH_TOKEN_KEY] = authToken
  if (baseUrl) env[BASE_URL_KEY] = baseUrl

  const root: JsonObject = { ...current.root, env }
  writeJsonAtomic(claudeSettingsPath(), root)
  return { root, env, authToken, baseUrl }
}

function normalizeInput(input: SaveClaudeAccountInput): SaveClaudeAccountInput {
  if (!input || typeof input !== 'object') {
    throw new ClaudeAccountError('INVALID_VALUE', '账户配置无效')
  }
  const id = typeof input.id === 'string' && input.id ? input.id : undefined
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const authToken = typeof input.authToken === 'string' ? input.authToken.trim() : ''
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''

  if (!name || name.length > MAX_NAME_LENGTH || /[\0\r\n]/.test(name)) {
    throw new ClaudeAccountError('INVALID_VALUE', `账户名称需为 1-${MAX_NAME_LENGTH} 个字符`)
  }
  if (!authToken || authToken.length > MAX_TOKEN_LENGTH || /[\0\r\n]/.test(authToken)) {
    throw new ClaudeAccountError('INVALID_VALUE', 'Token 不能为空，且不能包含换行')
  }
  if (baseUrl.length > MAX_URL_LENGTH || /[\0\r\n]/.test(baseUrl)) {
    throw new ClaudeAccountError('INVALID_VALUE', 'Base URL 格式无效')
  }
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new ClaudeAccountError('INVALID_VALUE', 'Base URL 必须是有效的 HTTP(S) 地址')
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !!url.username ||
      !!url.password
    ) {
      throw new ClaudeAccountError('INVALID_VALUE', 'Base URL 必须是有效的 HTTP(S) 地址')
    }
  }
  return { id, name, authToken, baseUrl }
}

function valuesMatch(
  account: Pick<DecryptedClaudeAccount, 'authToken' | 'baseUrl'>,
  current: Pick<ClaudeSettingsState, 'authToken' | 'baseUrl'>
): boolean {
  return account.authToken === current.authToken && account.baseUrl === current.baseUrl
}

function activeAccountId(
  store: ClaudeAccountStore,
  accounts: DecryptedClaudeAccount[],
  current: ClaudeSettingsState
): string | null {
  const matches = accounts.filter((account) => valuesMatch(account, current))
  return (
    matches.find((account) => account.id === store.preferredActiveId)?.id ??
    matches[0]?.id ??
    null
  )
}

function snapshotFrom(
  store: ClaudeAccountStore,
  accounts: DecryptedClaudeAccount[],
  current: ClaudeSettingsState
): ClaudeAccountsSnapshot {
  const activeId = activeAccountId(store, accounts, current)
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      tokenPreview: maskClaudeToken(account.authToken),
      baseUrl: account.baseUrl,
      active: account.id === activeId
    })),
    activeAccountId: activeId,
    currentUnsaved:
      !activeId && (current.authToken || current.baseUrl)
        ? {
            tokenPreview: maskClaudeToken(current.authToken),
            baseUrl: current.baseUrl
          }
        : null
  }
}

function currentSnapshot(): ClaudeAccountsSnapshot {
  const store = readAccountStore()
  return snapshotFrom(store, decryptAccounts(store), readClaudeSettings())
}

function result<T>(operation: () => T): ClaudeAccountResult<T> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    const safeError = asIoError(error, '账户配置操作失败')
    return {
      ok: false,
      error: { code: safeError.code, message: safeError.message }
    }
  }
}

export function loadClaudeAccounts(): ClaudeAccountResult<ClaudeAccountsSnapshot> {
  return result(currentSnapshot)
}

export function getClaudeAccount(
  id: string | null
): ClaudeAccountResult<ClaudeAccountDetail> {
  return result(() => {
    const store = readAccountStore()
    const accounts = decryptAccounts(store)
    const current = readClaudeSettings()
    const activeId = activeAccountId(store, accounts, current)

    if (id === null) {
      if (activeId || (!current.authToken && !current.baseUrl)) {
        throw new ClaudeAccountError('NOT_FOUND', '没有未保存的当前配置')
      }
      return {
        id: null,
        name: '当前账户',
        authToken: current.authToken,
        baseUrl: current.baseUrl,
        source: 'current',
        active: true
      }
    }

    const account = accounts.find((item) => item.id === id)
    if (!account) throw new ClaudeAccountError('NOT_FOUND', '账户不存在')
    return {
      id: account.id,
      name: account.name,
      authToken: account.authToken,
      baseUrl: account.baseUrl,
      source: 'saved',
      active: account.id === activeId
    }
  })
}

export function saveClaudeAccount(
  rawInput: SaveClaudeAccountInput
): ClaudeAccountResult<ClaudeAccountsSnapshot> {
  return result(() => {
    const input = normalizeInput(rawInput)
    const previousStore = readAccountStore()
    const previousAccounts = decryptAccounts(previousStore)
    const current = readClaudeSettings()
    const previousActiveId = activeAccountId(previousStore, previousAccounts, current)
    const existingIndex = input.id
      ? previousAccounts.findIndex((account) => account.id === input.id)
      : -1

    if (input.id && existingIndex < 0) {
      throw new ClaudeAccountError('NOT_FOUND', '账户不存在')
    }
    if (existingIndex < 0 && previousAccounts.length >= MAX_ACCOUNTS) {
      throw new ClaudeAccountError('INVALID_VALUE', `最多保存 ${MAX_ACCOUNTS} 个账户`)
    }
    if (
      previousAccounts.some(
        (account) =>
          account.id !== input.id && account.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()
      )
    ) {
      throw new ClaudeAccountError('NAME_EXISTS', '账户名称已存在')
    }

    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const previous = existingIndex >= 0 ? previousStore.accounts[existingIndex] : null
    const stored: StoredClaudeAccount = {
      id,
      name: input.name,
      authToken: encryptToken(input.authToken),
      baseUrl: input.baseUrl,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    const nextAccounts = [...previousStore.accounts]
    if (existingIndex >= 0) nextAccounts[existingIndex] = stored
    else nextAccounts.push(stored)

    const wasActive = previousActiveId === id
    const matchesUnsavedCurrent =
      !previousActiveId &&
      input.authToken === current.authToken &&
      input.baseUrl === current.baseUrl
    const nextStore: ClaudeAccountStore = {
      version: STORE_VERSION,
      preferredActiveId:
        wasActive || matchesUnsavedCurrent ? id : previousStore.preferredActiveId,
      accounts: nextAccounts
    }

    writeAccountStore(nextStore)
    let nextCurrent = current
    if (wasActive) {
      try {
        nextCurrent = updateClaudeSettings(input.authToken, input.baseUrl)
      } catch (error) {
        try {
          writeAccountStore(previousStore)
        } catch {}
        throw error
      }
    }
    return snapshotFrom(nextStore, decryptAccounts(nextStore), nextCurrent)
  })
}

export function activateClaudeAccount(
  id: string
): ClaudeAccountResult<ClaudeAccountsSnapshot> {
  return result(() => {
    if (typeof id !== 'string' || !id) {
      throw new ClaudeAccountError('INVALID_VALUE', '账户 ID 无效')
    }
    const previousStore = readAccountStore()
    const accounts = decryptAccounts(previousStore)
    const account = accounts.find((item) => item.id === id)
    if (!account) throw new ClaudeAccountError('NOT_FOUND', '账户不存在')
    readClaudeSettings()

    const nextStore: ClaudeAccountStore = {
      ...previousStore,
      preferredActiveId: id
    }
    writeAccountStore(nextStore)
    let current: ClaudeSettingsState
    try {
      current = updateClaudeSettings(account.authToken, account.baseUrl)
    } catch (error) {
      try {
        writeAccountStore(previousStore)
      } catch {}
      throw error
    }
    return snapshotFrom(nextStore, accounts, current)
  })
}

export function deleteClaudeAccount(
  id: string
): ClaudeAccountResult<ClaudeAccountsSnapshot> {
  return result(() => {
    if (typeof id !== 'string' || !id) {
      throw new ClaudeAccountError('INVALID_VALUE', '账户 ID 无效')
    }
    const store = readAccountStore()
    const index = store.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new ClaudeAccountError('NOT_FOUND', '账户不存在')

    const nextStore: ClaudeAccountStore = {
      version: STORE_VERSION,
      preferredActiveId: store.preferredActiveId === id ? null : store.preferredActiveId,
      accounts: store.accounts.filter((account) => account.id !== id)
    }
    writeAccountStore(nextStore)
    return snapshotFrom(nextStore, decryptAccounts(nextStore), readClaudeSettings())
  })
}
