import { create } from 'zustand'

// 全局重渲染驱动：controller 就地改状态后调 bump()，订阅 rev 的组件全部重拉数据。
// 不做细粒度 selector，代价是多余重渲染，但组件树很浅，简单性收益更大。
interface AppStore {
  rev: number
  bump: () => void
}

export const useAppStore = create<AppStore>((set) => ({
  rev: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 }))
}))

export function bump(): void {
  useAppStore.getState().bump()
}
