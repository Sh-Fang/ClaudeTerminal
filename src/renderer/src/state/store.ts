import { create } from 'zustand'

// 全局重渲染驱动：controller 就地修改状态后调 bump()，订阅 rev 的组件全部重拉数据。
// 沿用原「显式 render() 汇聚点」的心智模型——rev 就是所有 render() 调用的统一替身，
// 不做细粒度 selector，代价是多余重渲染，但本 app 组件树很浅，收益远大于复杂度。
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
