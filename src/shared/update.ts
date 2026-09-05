export type UpdateCheckResult =
  | { status: 'latest'; current: string; latest?: string }
  | { status: 'update'; current: string; latest: string }
  | { status: 'downloaded'; current: string; latest: string }
  | { status: 'busy'; current: string; latest?: string }
  | { status: 'error'; current: string; error: 'network' | 'notfound' | 'dev' }

export type UpdateActionResult =
  | { ok: true }
  | {
      ok: false
      error: 'busy' | 'not-owner' | 'not-ready' | 'failed'
      message?: string
    }

export type UpdateEvent =
  | { kind: 'progress'; percent: number; version: string }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; stage: 'download' | 'install'; message: string; version?: string }
