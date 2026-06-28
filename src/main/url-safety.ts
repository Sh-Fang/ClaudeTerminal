// 外开链接的统一白名单：只放行 http(s)，挡住 file: / 自定义协议等。
// ipc 的 shell:openExternal 与窗口的 setWindowOpenHandler / will-navigate 共用。
const SAFE_URL = /^https?:\/\/[^\s'"<>]+$/i

export function isSafeExternalUrl(url: unknown): url is string {
  return typeof url === 'string' && SAFE_URL.test(url)
}
