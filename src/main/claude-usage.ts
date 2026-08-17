import { app, net, session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// usage 接口对不受支持地区直接 403，需复用 cc settings.json 里配的代理。返回 Chromium proxyRules + 认证。
function readCcProxy(): { rules: string; username?: string; password?: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
      env?: Record<string, string>
    }
    const p = s?.env?.HTTPS_PROXY || s?.env?.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    if (!p) return null
    const u = new URL(p)
    return {
      rules: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined
    }
  } catch {
    return null
  }
}

// 该接口按 UA 白名单放行，缺 cc 的 UA 会被激进限流甚至拒绝
const CC_UA = 'claude-code/2.1.215'

// cc 登录后的 OAuth 凭据；accessToken 即账号级用量接口的 Bearer
const CRED_FILE = (): string => join(homedir(), '.claude', '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TTL_MS = 180_000 // 180s 内复用缓存

export interface UsageWindow {
  utilization: number // 0~100
  resetsAt: string | null // ISO，UTC
  // 有值 = 某模型的专属周配额（如 'Fable'）；无值 = 账号级总额度
  scopeLabel?: string
}
export interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow // 主显示的周额度：账号总池优先，缺总池才退回模型级（带 scopeLabel）
  sevenDayModel?: UsageWindow | null // 模型级周额度（如 Fable）；仅在主条是账号总池时用于 hover 展示
  sevenDayOpus?: UsageWindow | null
  sevenDaySonnet?: UsageWindow | null
  fetchedAt: number
}

let cache: ClaudeUsage | null = null
let inflight: Promise<ClaudeUsage> | null = null

// statusline 探针从 cc stdin 的 rate_limits 落下的账号用量快照；cc 自己联网拿到，此路不依赖代理。
const ACCOUNT_FILE = (): string => join(app.getPath('userData'), 'session-status', '_account-usage.json')

function readAccountSnapshot(): ClaudeUsage | null {
  try {
    const c = JSON.parse(readFileSync(ACCOUNT_FILE(), 'utf8')) as {
      fiveHour?: { percent?: number; resetsAt?: string | null } | null
      sevenDay?: { percent?: number; resetsAt?: string | null } | null
      savedAt?: number
    }
    const win = (w: { percent?: number; resetsAt?: string | null } | null | undefined): UsageWindow | undefined =>
      w && typeof w.percent === 'number' ? { utilization: w.percent, resetsAt: w.resetsAt ?? null } : undefined
    const fiveHour = win(c.fiveHour)
    const sevenDay = win(c.sevenDay)
    if (!fiveHour && !sevenDay) return null
    return { ok: true, fiveHour, sevenDay, fetchedAt: c.savedAt || Date.now() }
  } catch {
    return null
  }
}

// 排障：最近一次拉取的关键信息覆盖写到 userData
function debugLog(line: string): void {
  try {
    writeFileSync(join(app.getPath('userData'), 'claude-usage-debug.log'), line, 'utf8')
  } catch {}
}

function readToken(): { token: string } | { error: string } {
  let raw: string
  try {
    raw = readFileSync(CRED_FILE(), 'utf8')
  } catch {
    return { error: '未找到 cc 凭据，请先在 cc 内登录' }
  }
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
      .claudeAiOauth
    if (!oauth?.accessToken) return { error: '凭据缺少 accessToken' }
    if (typeof oauth.expiresAt === 'number' && Date.now() > oauth.expiresAt) {
      return { error: 'token 已过期，在 cc 内发一条消息会自动刷新' }
    }
    return { token: oauth.accessToken }
  } catch {
    return { error: '凭据文件解析失败' }
  }
}

// 必须用 Electron net 模块（Chromium 网络栈）：node undici 会被 Cloudflare 按 TLS 指纹拦，
// 且需自动套用系统/cc 代理；代理认证走 request 的 'login' 事件。
async function netUsage(token: string): Promise<{ status: number; body: string; err?: string }> {
  const proxy = readCcProxy()
  const ses = session.fromPartition('claude-usage-probe')
  try {
    await ses.setProxy(proxy ? { proxyRules: proxy.rules } : { mode: 'system' })
  } catch {
    // setProxy 失败退回系统代理
  }
  return new Promise((resolve) => {
    let done = false
    let timer: NodeJS.Timeout | null = null
    const finish = (v: { status: number; body: string; err?: string }): void => {
      if (done) return
      done = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve(v)
    }
    try {
      const req = net.request({ method: 'GET', url: USAGE_URL, session: ses })
      req.on('login', (authInfo, cb) => {
        if (authInfo.isProxy && proxy?.username) cb(proxy.username, proxy.password)
        else cb()
      })
      req.setHeader('Authorization', `Bearer ${token}`)
      req.setHeader('anthropic-beta', 'oauth-2025-04-20')
      req.setHeader('User-Agent', CC_UA)
      req.setHeader('Content-Type', 'application/json')
      req.on('response', (res) => {
        let body = ''
        res.on('data', (c) => {
          body += c.toString()
        })
        res.on('end', () => finish({ status: res.statusCode, body }))
        res.on('error', (e: Error) => finish({ status: 0, body: '', err: e.message }))
      })
      req.on('error', (e) => finish({ status: 0, body: '', err: e.message }))
      // 超时只 resolve 不 abort——abort 在某些代理/TLS 异常下会引发底层 socket 错误
      timer = setTimeout(() => {
        finish({ status: 0, body: '', err: '请求超时' })
      }, 10_000)
      req.end()
    } catch (e) {
      finish({ status: 0, body: '', err: (e as Error).message })
    }
  })
}

function pickWindow(v: unknown): UsageWindow | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const u = typeof o.utilization === 'number' ? o.utilization : Number(o.utilization)
  if (!Number.isFinite(u)) return null
  return { utilization: u, resetsAt: typeof o.resets_at === 'string' ? o.resets_at : null }
}

// 周额度在 limits[]：kind='weekly_all' 为账号总池，'weekly_scoped' 为模型专属配额。
// 返回 overall（总池）与 scoped（用量最高的模型级）；无 kind 的旧结构按 scope 兜底判断。
function pickWeekly(raw: Record<string, unknown>): {
  overall: UsageWindow | null
  scoped: UsageWindow | null
} {
  const limits = raw.limits
  if (!Array.isArray(limits)) return { overall: null, scoped: null }
  let overall: UsageWindow | null = null
  let scoped: UsageWindow | null = null
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const kind = typeof o.kind === 'string' ? o.kind : ''
    const isWeekly = o.group === 'weekly' || kind.includes('weekly')
    if (!isWeekly || typeof o.percent !== 'number') continue
    const scope = o.scope as { model?: { display_name?: unknown } } | null | undefined
    const m = scope?.model?.display_name
    const model = typeof m === 'string' ? m.trim() : ''
    const win = (label?: string): UsageWindow => ({
      utilization: o.percent as number,
      resetsAt: typeof o.resets_at === 'string' ? o.resets_at : null,
      scopeLabel: label
    })
    const isAll = kind === 'weekly_all' || !model || /^all models$/i.test(model)
    if (isAll) {
      if (!overall || (o.percent as number) > overall.utilization) overall = win()
    } else {
      if (!scoped || (o.percent as number) > scoped.utilization) scoped = win(model)
    }
  }
  return { overall, scoped }
}

async function fetchFresh(): Promise<ClaudeUsage> {
  const now = Date.now()
  const fail = (error: string, dbg: string): ClaudeUsage => {
    debugLog(`[${new Date(now).toISOString()}] FAIL ${error}\n${dbg}`)
    return { ok: false, error, fetchedAt: now }
  }

  const cred = readToken()
  if ('error' in cred) return fail(cred.error, 'readToken')

  const { status, body, err } = await netUsage(cred.token)
  if (err) return fail(err, 'net error')
  if (!body.trim()) return fail(`接口无返回 (HTTP ${status})`, 'empty body')

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(body) as Record<string, unknown>
  } catch {
    return fail(`返回非 JSON (HTTP ${status})`, body.slice(0, 300))
  }

  // 接口报错是 {"error":{...}} 形态，别当成功解析成 0%
  if (status !== 200 || (raw.error && typeof raw.error === 'object')) {
    const m =
      (raw.error as { message?: string } | undefined)?.message || JSON.stringify(raw.error ?? raw)
    return fail(`接口拒绝 (HTTP ${status})：${m}`, body.slice(0, 300))
  }

  const fiveHour = pickWindow(raw.five_hour)
  // 顶层 seven_day 已废弃恒 null，真数据在 limits[]；总池优先，缺总池才退回模型级
  const wk = pickWeekly(raw)
  const overall = pickWindow(raw.seven_day) || wk.overall
  const sevenDay = overall || wk.scoped
  const sevenDayModel = wk.scoped
  if (!fiveHour && !sevenDay) {
    return fail('返回里没有用量字段', body.slice(0, 300))
  }

  debugLog(
    `[${new Date(now).toISOString()}] OK five=${fiveHour?.utilization ?? '-'} week=${sevenDay?.utilization ?? '-'} model=${sevenDayModel?.scopeLabel ?? '-'}`
  )
  return {
    ok: true,
    fiveHour: fiveHour ?? undefined,
    sevenDay: sevenDay ?? undefined,
    sevenDayModel: sevenDayModel ?? null,
    sevenDayOpus: pickWindow(raw.seven_day_opus),
    sevenDaySonnet: pickWindow(raw.seven_day_sonnet),
    fetchedAt: now
  }
}

// API 失败后的冷却期，避免每次 UI poll 都发注定失败的请求
const FAIL_BACKOFF_MS = 600_000
let lastApiFailAt = 0

// OAuth usage API 结果（带缓存/节流/去重）。成功进 cache，失败记冷却时间。
async function fetchApiUsage(force: boolean): Promise<ClaudeUsage> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache
  if (!force && Date.now() - lastApiFailAt < FAIL_BACKOFF_MS) {
    return { ok: false, error: 'usage API 冷却中', fetchedAt: Date.now() }
  }
  if (inflight) return inflight
  inflight = fetchFresh()
    .then((r) => {
      if (r.ok) cache = r
      else lastApiFailAt = Date.now()
      return r
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// force=true 跳过缓存。
export async function getClaudeUsage(force = false): Promise<ClaudeUsage> {
  // 首选 statusline 快照（无需代理）：账号级 5h / 周额度从这里来
  const snap = readAccountSnapshot()
  if (snap) {
    // 快照有两处天然缺口都得靠带缓存的 OAuth API 补：① rate_limits 常缺 seven_day；
    // ② 快照永远不含模型级细分（sevenDayModel/opus/sonnet，只 OAuth API 有）——后者正是
    // hover 弹「Fable 额度」卡片的数据源，之前只在缺周额度时才补，快照一旦带上 seven_day 就
    // 短路直返、模型级永为 undefined，卡片随之消失。两种缺口任一命中即补，但都不覆盖快照已有的
    // 账号级 sevenDay（statusline 更权威且不依赖代理）。
    const needWeekly = !snap.sevenDay
    const needModel = snap.sevenDayModel == null
    if (snap.fiveHour && (needWeekly || needModel)) {
      const api = await fetchApiUsage(force)
      if (api.ok) {
        if (needWeekly && api.sevenDay) snap.sevenDay = api.sevenDay
        snap.sevenDayModel = api.sevenDayModel ?? null
        snap.sevenDayOpus = api.sevenDayOpus ?? null
        snap.sevenDaySonnet = api.sevenDaySonnet ?? null
      }
    }
    return snap
  }

  // 退路：直连 OAuth usage API（需能直连或走代理）
  return fetchApiUsage(force)
}
