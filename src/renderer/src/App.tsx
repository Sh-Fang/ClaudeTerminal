import { useEffect } from 'react'
import { useAppStore } from './state/store'
import { getSettings } from './controller'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { TerminalHosts } from './components/TerminalHosts'
import { SearchBar } from './components/SearchBar'
import { SessionInfoBar } from './components/SessionInfoBar'
import { OverlayHost, ToastHost } from './components/OverlayHost'
import { SettingsPanel } from './components/SettingsPanel'
import { SavedManager } from './components/SavedManager'
import { HistoryDialog } from './components/HistoryDialog'

export function App() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const s = getSettings()

  // <html> 上的主题 data 属性与侧边栏尺寸 CSS 变量统一在此维护，每次 rev 变化后兜底对齐。
  useEffect(() => {
    if (s.appTheme === 'dark') document.documentElement.dataset.appTheme = 'dark'
    else delete document.documentElement.dataset.appTheme
    document.documentElement.style.setProperty('--sidebar-w', `${s.sidebarWidth}px`)
    if (s.sidebarSavedHeight > 0) {
      document.documentElement.style.setProperty('--saved-h', `${s.sidebarSavedHeight}px`)
    } else {
      document.documentElement.style.removeProperty('--saved-h')
    }
  })

  const appCls = [
    'app',
    s.tabBarMode === 'horizontal' ? 'tabbar-horizontal' : '',
    s.sidebarCollapsed ? 'sidebar-collapsed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <TitleBar />
      <div className={appCls}>
        <Sidebar />
        <div className="main">
          <Toolbar />
          <TerminalHosts />
          <SearchBar />
          <SessionInfoBar />
          <ToastHost />
        </div>
      </div>
      <OverlayHost />
      <SettingsPanel />
      <SavedManager />
      <HistoryDialog />
    </>
  )
}
