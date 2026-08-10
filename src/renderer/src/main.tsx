import '@xterm/xterm/css/xterm.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { preBoot, initApp } from './controller'

// 启动次序：先加载 settings 定死语言（t() 依赖），再挂 React 树，最后 initApp 注册 IPC、加载 workspace
void (async () => {
  await preBoot()
  createRoot(document.getElementById('root')!).render(<App />)
  await initApp()
})()
