import type { TermBridge } from './index'

declare global {
  interface Window {
    term: TermBridge
  }
}

export {}
