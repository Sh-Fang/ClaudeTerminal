// 跨模块共享的视图类型，controller 与各组件统一从此导入

import type { TerminalTab, SessionRecord } from './terminal-tab'

// 侧边栏视图
export interface GroupView {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
  dirty: boolean
}

export interface SavedView {
  id: string
  name: string
  cwd: string
  tabCount: number
  savedAt: string
}

export interface SavedWorkspaceView {
  id: string
  name: string
  savedAt: string
  groupCount: number
  tabCount: number
}

// 管理弹窗视图
export interface ManageSessionView {
  sessionId: string
  title: string
  hasUserTitle: boolean
  source: string
  ts?: string
  isActive: boolean // 是否该标签的默认活跃会话（activeSessionId）
}

export interface ManageTabView {
  id: string
  name: string
  sessions: ManageSessionView[]
  savedAt?: string
  lastTs?: string
  memo?: string
}

export interface ManageGroupView {
  id: string
  name: string
  cwd: string
  savedAt: string
  tabs: ManageTabView[]
}

export interface ManageWorkspaceGroupView {
  id: string
  name: string
  cwd: string
  tabCount: number
}

export interface ManageWorkspaceView {
  id: string
  name: string
  savedAt: string
  groupCount: number
  tabCount: number
  groups: ManageWorkspaceGroupView[]
}

// 标签历史条目
export interface HistoryEntry {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  memo?: string
  openedAt: string
  lastSeenAt: string
}
