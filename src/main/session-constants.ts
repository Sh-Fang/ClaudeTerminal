// 会话来源 / 标签状态的合法取值。主进程多处校验共用，避免各文件各写一份导致漂移。

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume'
export type TabStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

export const SESSION_SOURCES: readonly SessionSource[] = ['startup', 'clear', 'compact', 'resume']
export const TAB_STATES: readonly TabStatus[] = ['busy', 'attention', 'done', 'idle', 'error']

const SOURCE_SET = new Set<string>(SESSION_SOURCES)
const STATE_SET = new Set<string>(TAB_STATES)

export function isSessionSource(v: unknown): v is SessionSource {
  return typeof v === 'string' && SOURCE_SET.has(v)
}

export function isTabStatus(v: unknown): v is TabStatus {
  return typeof v === 'string' && STATE_SET.has(v)
}
