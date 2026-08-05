import { I18N_EN } from '../shared/i18n-dict'

// 主进程侧 i18n：启动时从 settings 读一次语言（见 index.ts），重启后生效。
// 注意：经 IPC 返回给渲染层的 error/detail 字符串保持中文原文 —— 渲染层展示时
// 用自己的 t() 兜底翻译；这里的 t() 只用于主进程直接呈现的 UI（托盘、原生对话框）。
export type AppLanguage = 'zh' | 'en'

let lang: AppLanguage = 'zh'

export function setLanguage(l: AppLanguage): void {
  lang = l
}

// key 支持 '||' 消歧后缀（与渲染层 i18n.ts 同规则）
export function t(zh: string, ...args: Array<string | number>): string {
  const cut = zh.indexOf('||')
  const base = cut >= 0 ? zh.slice(0, cut) : zh
  const tpl = lang === 'en' ? I18N_EN[zh] ?? I18N_EN[base] ?? base : base
  if (args.length === 0) return tpl
  return tpl.replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)]
    return v === undefined ? m : String(v)
  })
}
