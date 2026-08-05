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

// t('安装失败：{0}', err)：中文原文即 key，占位符 {0} {1}… 按参数序号替换。
// English 缺词条时回退中文原文 —— 漏翻只会显示中文，不会坏。
// 注意：不要在模块顶层 const 初始化时调用（那时语言还没 set），在使用处调用。
// key 支持 '||' 消歧后缀：同一中文在不同位置要翻成不同英文时，
// 用 t('恢复||来源')——zh 模式截掉 '||' 及之后的部分显示，en 模式按完整 key 查词典。
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

// 静态 HTML 的一次性翻译：语言为 en 时，把 root 下所有文本节点与常见文案属性
// （title / placeholder / aria-label）按词典替换。中文原文即 key，无需给 HTML 加标注。
// 例外：同一中文在不同位置要翻成不同英文时，给元素加 data-i18n="消歧key" 指定词条。
// 只在启动时（设置加载后、动态渲染前）调用一次；动态生成的内容走 t()。
const I18N_ATTRS = ['title', 'placeholder', 'aria-label'] as const

export function translateDom(root: ParentNode = document): void {
  if (lang !== 'en') return
  const walker = document.createTreeWalker(
    root instanceof Node ? root : document,
    NodeFilter.SHOW_TEXT
  )
  const texts: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) texts.push(n as Text)
  for (const tn of texts) {
    const raw = tn.nodeValue
    if (!raw) continue
    const parent = tn.parentElement
    const forced = parent?.getAttribute('data-i18n')
    if (forced && I18N_EN[forced]) {
      tn.nodeValue = I18N_EN[forced]
      continue
    }
    const trimmed = raw.trim()
    if (!trimmed) continue
    const en = I18N_EN[trimmed]
    if (en !== undefined) tn.nodeValue = raw.replace(trimmed, en)
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const a of I18N_ATTRS) {
      const v = el.getAttribute(a)
      if (v !== null && I18N_EN[v] !== undefined) el.setAttribute(a, I18N_EN[v])
    }
  }
}
