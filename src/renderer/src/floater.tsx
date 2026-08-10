// 悬浮窗 React 入口：先加载 settings 定死语言再挂 React 树；复用主窗口同款 preload，window.term 可用
import { createRoot } from 'react-dom/client'
import { setLanguage } from './i18n'
import { FloaterApp } from './components/FloaterApp'

void (async () => {
  // 语言取自 settings；加载失败不阻塞渲染，只有右键菜单文案会退回中文
  try {
    const s = await window.term?.loadSettings?.()
    if (s) setLanguage(s.language)
  } catch {
    /* 设置读取失败时保持默认语言 */
  }
  createRoot(document.getElementById('root')!).render(<FloaterApp />)
})()
