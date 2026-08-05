import '@xterm/xterm/css/xterm.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { preBoot, initApp } from './controller'

// 启动次序：先加载 settings 并定死语言（所有 t() 依赖它），再挂 React 树，
// 最后 initApp 注册 IPC 监听、加载 workspace（内部会等 #hosts 挂载完成）。
void (async () => {
  await preBoot()
  createRoot(document.getElementById('root')!).render(<App />)
  await initApp()
})()
