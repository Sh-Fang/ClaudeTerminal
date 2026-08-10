import { I18N_EN } from '../../shared/i18n-dict'

// 界面语言。'zh' = 简体中文（默认，源码原文）；'en' = English（查词典）。
export type AppLanguage = 'zh' | 'en'

let lang: AppLanguage = 'zh'

export function setLanguage(l: AppLanguage): void {
  lang = l
}
export function getLanguage(): AppLanguage {
  return lang
}

// t('安装失败：{0}', err)：中文原文即 key；en 缺词条回退中文原文。
// key 支持 '||' 消歧后缀（如 t('恢复||来源')）：zh 截掉 '||' 后显示，en 按完整 key 查词典。
// 不要在模块顶层 const 初始化时调用（那时语言还没 set）。
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
