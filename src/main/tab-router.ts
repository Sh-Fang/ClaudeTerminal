// 多窗口路由表：tabId / ptyId → 承载它的 WebContents。标签可被拖到副窗口，
// 所有按 tabId/ptyId 寻址的推送都要先经这里解析目标；找不到路由回退主窗口。
// 迁移窗口期 PTY 输出经 holdPty/flushPty 暂存回放，保证快照与实时流无缝衔接。
import type { WebContents } from 'electron'

let getFallbackWc: () => WebContents | null = () => null

export function setFallbackWcGetter(fn: () => WebContents | null): void {
  getFallbackWc = fn
}

const tabRoutes = new Map<string, WebContents>()
const ptyRoutes = new Map<number, WebContents>()

// 迁移中的 PTY 输出暂存队列（带 channel：pty:data / pty:exit 都可能在迁移窗口期到达）
const heldPty = new Map<number, { channel: string; payload: unknown }[]>()

function alive(wc: WebContents | undefined | null): WebContents | null {
  return wc && !wc.isDestroyed() ? wc : null
}

export function claimTab(tabId: string, wc: WebContents): void {
  tabRoutes.set(tabId, wc)
}

export function releaseTab(tabId: string): void {
  tabRoutes.delete(tabId)
}

export function resolveTabWc(tabId: string): WebContents | null {
  return alive(tabRoutes.get(tabId)) ?? alive(getFallbackWc())
}

export function tabOwnerWc(tabId: string): WebContents | null {
  return alive(tabRoutes.get(tabId))
}

export function setPtyRoute(ptyId: number, wc: WebContents): void {
  ptyRoutes.set(ptyId, wc)
}

export function releasePty(ptyId: number): void {
  ptyRoutes.delete(ptyId)
  heldPty.delete(ptyId)
}

// PTY 输出投递入口：迁移中入队；否则按路由（兜底主窗口）发送
export function routePtyData(ptyId: number, channel: string, payload: unknown): void {
  const q = heldPty.get(ptyId)
  if (q) {
    q.push({ channel, payload })
    return
  }
  const wc = alive(ptyRoutes.get(ptyId)) ?? alive(getFallbackWc())
  if (!wc) return
  try { wc.send(channel, payload) } catch {}
}

// 开始暂存：迁移协调器在源窗口 serialize 之前调用，保证快照与队列无缝衔接
export function holdPty(ptyId: number): void {
  if (!heldPty.has(ptyId)) heldPty.set(ptyId, [])
}

// 结束暂存：路由切到目标窗口并按各自 channel 回放队列
export function flushPty(ptyId: number, wc: WebContents): void {
  const q = heldPty.get(ptyId)
  heldPty.delete(ptyId)
  ptyRoutes.set(ptyId, wc)
  if (!q || q.length === 0) return
  const target = alive(wc)
  if (!target) return
  for (const item of q) {
    try { target.send(item.channel, item.payload) } catch {}
  }
}

// 窗口销毁：清掉它名下的全部路由，返回它占有的 ptyId（调用方负责 kill 泄漏的 PTY）
export function dropWc(wc: WebContents): number[] {
  for (const [tabId, w] of tabRoutes) {
    if (w === wc) tabRoutes.delete(tabId)
  }
  const orphans: number[] = []
  for (const [ptyId, w] of ptyRoutes) {
    if (w === wc) {
      orphans.push(ptyId)
      ptyRoutes.delete(ptyId)
      heldPty.delete(ptyId)
    }
  }
  return orphans
}

// 某窗口是否还承载任何标签（副窗口空了可以静默关闭）
export function wcHasTabs(wc: WebContents): boolean {
  for (const w of tabRoutes.values()) {
    if (w === wc) return true
  }
  return false
}
