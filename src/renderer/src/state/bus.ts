// 极简事件总线：controller（非 React 世界）向组件推一次性信号；新事件往 BusEvent 联合里加
export type BusEvent = 'sessionInfo:nudge'

const listeners = new Map<BusEvent, Set<() => void>>()

export function busOn(ev: BusEvent, fn: () => void): () => void {
  let set = listeners.get(ev)
  if (!set) {
    set = new Set()
    listeners.set(ev, set)
  }
  set.add(fn)
  return () => set!.delete(fn)
}

export function busEmit(ev: BusEvent): void {
  const set = listeners.get(ev)
  if (!set) return
  for (const fn of [...set]) fn()
}
