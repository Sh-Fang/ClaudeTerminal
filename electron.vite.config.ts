import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const EXTERNAL = ['electron', '@lydell/node-pty']

// 仅 dev 生效：@vitejs/plugin-react 的 react-refresh 预热脚本是内联 <script>，
// 会被 script-src 'self' 拦下导致 HMR 报错。这里在 dev server 阶段把 CSP 放宽，
// 生产构建（apply: 'serve' 不参与 build）仍是严格 CSP。
const devCspRelax = {
  name: 'dev-csp-relax',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html.replace(/script-src 'self'/g, "script-src 'self' 'unsafe-inline'")
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: EXTERNAL,
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: EXTERNAL,
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCspRelax],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          floater: resolve(__dirname, 'src/renderer/floater.html')
        }
      }
    }
  }
})
