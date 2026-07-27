import { app, net, session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 官方 usage 接口对不受支持地区直接 403（Request not allowed）。cc 自己走 settings.json 里
// 配的代理才拿得到数据，所以这里也复用同一个代理。返回 Chromium proxyRules + 认证。
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

// cc 的 User-Agent 是这个接口的"白名单"，缺了会被激进限流甚至拒绝。版本号跟着 cc 大版本走即可。
const CC_UA = 'claude-code/2.1.215'

// cc 登录后把 OAuth 凭据存这里；accessToken 就是调用账号级用量接口用的 Bearer。
const CRED_FILE = (): string => join(homedir(), '.claude', '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TTL_MS = 180_000 // 接口建议节流，180s 内复用缓存

export interface UsageWindow {
  utilization: number // 0~100
  resetsAt: string | null // ISO，UTC
  // 该周额度按模型 scope 拆分时的模型名（如 'Fable'）。有值 = 这是某个模型的专属周配额，
  // 而非账号级总周额度 → UI 显示「Fable额度」而不是「本周额度」。无值 = 账号级总额度。
  scopeLabel?: string
}
export interface ClaudeUsage {
  ok: boolean
  error?: string
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  sevenDayOpus?: UsageWindow | null
  sevenDaySonnet?: UsageWindow | null
  fetchedAt: number
}

let cache: ClaudeUsage | null = null
let inflight: Promise<ClaudeUsage> | null = null

// statusline 探针从 cc stdin 的 rate_limits 落下的账号用量快照。
// cc 自己联网拿到，所以这条路不依赖代理/直连——这正是 claude-hud 关了 Clash 也能用的原因。
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

// 排障用：把最近一次拉取的关键信息覆盖写到 userData，方便定位 0%/失败。
function debugLog(line: string): void {
  try {
    writeFileSync(join(app.getPath('userData'), 'claude-usage-debug.log'), line, 'utf8')
  } catch {
    // 日志失败无所谓
  }
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

// 直连此接口会被 Anthropic 拦成 403（需经用户的代理出口），且 node 的 undici 还会被
// Cloudflare 按 TLS 指纹拦。用 Electron 的 net 模块：走 Chromium 网络栈 → 自动套用系统
// 代理（WinINET）+ 真实浏览器 TLS 指纹，两个问题一并解决；token 也只在内存里当请求头，
// 不经过命令行。
async function netUsage(token: string): Promise<{ status: number; body: string; err?: string }> {
  // 走 cc 那条代理（若配了）：用独立内存 session 设代理，代理认证走 request 的 'login' 事件。
  const proxy = readCcProxy()
  const ses = session.fromPartition('claude-usage-probe')
  try {
    await ses.setProxy(proxy ? { proxyRules: proxy.rules } : { mode: 'system' })
  } catch {
    // setProxy 失败就退回 session 默认（系统代理）
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
      // 超时兜底：只清定时器并 resolve，不主动 abort 请求——abort 在某些代理/TLS
      // 异常下可能引发底层 socket 错误，求稳不碰；请求自然结束后因 done=true 被忽略。
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

// 顶层 seven_day 常年为 null，真正的周额度在 limits[] 里 group/kind 带 "weekly" 的项。
// 实测这些项常按模型 scope 拆分（如只用了 Fable → 只有一条 scope.model='Fable' 的 weekly，
// 压根没有账号级总周额度）。可能有多条 → 取用量最高的那条；若它带模型 scope，则记下模型名
// （scopeLabel），交给 UI 显示成「Fable额度」而非笼统的「本周额度」。
function pickWeekly(raw: Record<string, unknown>): UsageWindow | null {
  const limits = raw.limits
  if (!Array.isArray(limits)) return null
  let best: UsageWindow | null = null
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const isWeekly = o.group === 'weekly' || (typeof o.kind === 'string' && o.kind.includes('weekly'))
    if (!isWeekly || typeof o.percent !== 'number') continue
    if (best && o.percent <= best.utilization) continue
    const scope = o.scope as { model?: { display_name?: unknown } } | null | undefined
    const model = scope?.model?.display_name
    best = {
      utilization: o.percent,
      resetsAt: typeof o.resets_at === 'string' ? o.resets_at : null,
      scopeLabel: typeof model === 'string' && model.trim() ? model.trim() : undefined
    }
  }
  return best
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

  // 接口报错时是 {"error":{"type":..,"message":..}} 形态——别当成功解析成 0%。
  if (status !== 200 || (raw.error && typeof raw.error === 'object')) {
    const m =
      (raw.error as { message?: string } | undefined)?.message || JSON.stringify(raw.error ?? raw)
    return fail(`接口拒绝 (HTTP ${status})：${m}`, body.slice(0, 300))
  }

  const fiveHour = pickWindow(raw.five_hour)
  // 顶层 seven_day 为 null 时退到 limits[] 里的 weekly 项
  const sevenDay = pickWindow(raw.seven_day) || pickWeekly(raw)
  if (!fiveHour && !sevenDay) {
    return fail('返回里没有用量字段', body.slice(0, 300))
  }

  debugLog(
    `[${new Date(now).toISOString()}] OK five=${fiveHour?.utilization ?? '-'} week=${sevenDay?.utilization ?? '-'}`
  )
  return {
    ok: true,
    fiveHour: fiveHour ?? undefined,
    sevenDay: sevenDay ?? undefined,
    sevenDayOpus: pickWindow(raw.seven_day_opus),
    sevenDaySonnet: pickWindow(raw.seven_day_sonnet),
    fetchedAt: now
  }
}

// API 失败后的冷却：403/超时等失败后 BACKOFF 内不再打，免得每次 UI poll 都发无用请求
// （典型场景：cc 的 rate_limits 只给 five_hour，缺 seven_day，这里每次都想补但接口一直 403）。
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

// force=true 跳过缓存（如用户刚在设置里开启时想立刻看到）。
export async function getClaudeUsage(force = false): Promise<ClaudeUsage> {
  // 1) 首选：cc statusline stdin 落下的账号用量快照。cc 已联网拿到，无需代理/直连，
  //    且只要在 app 里开过 cc 就有数据（含上次会话残留的快照）。
  const snap = readAccountSnapshot()
  if (snap) {
    // cc 的 rate_limits 经常只给 five_hour、没有 seven_day → 本周额度会缺。
    // 用 OAuth usage API 补周额度（走系统代理；拿不到就维持缺失，UI 会隐藏本周项而非误显 0%）。
    if (snap.fiveHour && !snap.sevenDay) {
      const api = await fetchApiUsage(force)
      if (api.ok && api.sevenDay) {
        snap.sevenDay = api.sevenDay
        snap.sevenDayOpus = api.sevenDayOpus ?? null
        snap.sevenDaySonnet = api.sevenDaySonnet ?? null
      }
    }
    return snap
  }

  // 2) 退路（首次还没跑过任何 cc 时的引导）：直连 OAuth usage API，需要能直连或走代理。
  return fetchApiUsage(force)
}
