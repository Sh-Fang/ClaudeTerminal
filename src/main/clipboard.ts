import { clipboard } from 'electron'

/*
 * 剪贴板读取协议
 * ───────────────────────────────────────────────────────────────
 * Windows 资源管理器复制文件后剪贴板里是 CF_HDROP（DROPFILES 头 + 路径串列表）。
 * 优先识别这个格式，把文件路径解析出来；解析不到再回退到纯文本。
 *
 * DROPFILES 内存布局：
 *   byte  0:  pFiles  uint32 LE  — 字符串列表相对结构起点的字节偏移
 *   byte  4:  pt.x    int32      — 不使用
 *   byte  8:  pt.y    int32      — 不使用
 *   byte 12:  fNC     uint32     — 不使用
 *   byte 16:  fWide   uint32     — 0=ANSI  1=UTF-16LE
 *   byte 20+: payload — 一段以 NUL 分隔、整体以双 NUL 终止的字符串列表
 *
 * 返回值用 discriminated union，renderer 直接 switch(kind) 处理三种情形。
 */

export type ClipboardRead =
  | { kind: 'files'; files: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

const DROPFILES_HEADER_BYTES = 20
const OFFSET_FIELD_OFFSET = 0
const FWIDE_FIELD_OFFSET = 16

export function readClipboardSelection(): ClipboardRead {
  // 优先 CF_HDROP（一次拿多文件）；拿不到再走 FileNameW/FileName 兜底（单文件）。
  // 某些 Electron/Windows 组合下 readBuffer('CF_HDROP') 会返回空 buffer，
  // 但 read('FileNameW') 这条路径稳定，能保证"复制了文件 → 粘贴出路径"。
  let files = readDropFiles()
  if (files.length === 0) files = readSingleFileName()
  if (files.length > 0) return { kind: 'files', files }
  const text = clipboard.readText()
  if (text) return { kind: 'text', text }
  return { kind: 'empty' }
}

// 兜底：clipboard.read('FileNameW') 返回首文件路径（宽字符串），
// 'FileName' 是 ANSI 字符串。两个都试一遍，谁有用谁。
function readSingleFileName(): string[] {
  if (process.platform !== 'win32') return []
  // FileNameW：原生 UTF-16LE。直接读 buffer 自己解码，不走 Electron 的 read(string)
  // 那条不确定按啥编码转码的路径，避免中文文件名乱码。
  try {
    const buf = clipboard.readBuffer('FileNameW')
    if (buf && buf.length >= 2) {
      const evenLen = buf.length - (buf.length % 2)
      const s = buf.subarray(0, evenLen).toString('utf16le').replace(/\0+$/g, '').trim()
      if (s) return [s]
    }
  } catch {}
  // ANSI FileName 兜底：Electron read 对 ANSI 编码不一定正确处理，但能接 ASCII 路径
  try {
    const s = clipboard.read('FileName')
    if (s && s.trim()) {
      const cleaned = s.replace(/\0+$/g, '').trim()
      if (cleaned) return [cleaned]
    }
  } catch {}
  return []
}

export function writeClipboardText(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  clipboard.writeText(text)
  return true
}

// ── 内部 ─────────────────────────────────────────────────────

function readDropFiles(): string[] {
  if (process.platform !== 'win32') return []
  try {
    // 不再用 availableFormats() 预筛选：Electron 在不同版本/环境下，
    // availableFormats 可能返回 MIME 名（text/plain）而非 Win32 原生格式名（CF_HDROP），
    // 预筛选会误把"复制了文件"判成"剪贴板里没有 files"。直接尝试 readBuffer，
    // 失败/buffer 不合法自然回退到 readText，零代价。
    let buf: Buffer | undefined
    try { buf = clipboard.readBuffer('CF_HDROP') } catch {}
    if (!buf || buf.length < DROPFILES_HEADER_BYTES) return []
    const offset = buf.readUInt32LE(OFFSET_FIELD_OFFSET)
    const fWide = buf.readUInt32LE(FWIDE_FIELD_OFFSET) !== 0
    if (offset >= buf.length) return []
    const payload = buf.slice(offset)
    if (fWide) {
      // UTF-16LE：一次性 Buffer.toString('utf16le') 解码，比循环 readUInt16LE 更可靠
      // （正确处理 surrogate pair；payload 长度若为奇数尾字节会被自然丢弃）。
      // 资源管理器复制文件走这条路。
      const evenLen = payload.length - (payload.length % 2)
      return payload
        .subarray(0, evenLen)
        .toString('utf16le')
        .split('\0')
        .filter((s) => s.length > 0)
    }
    // ANSI 分支（fWide=0）：现代 Windows 极少见。Node 标准库不支持 GBK，
    // 按 latin1 退化解码——含非 ASCII 文件名会乱码，但能避免崩。
    return parseNulSeparatedList(payload, 1)
  } catch {
    return []
  }
}

// 解析以单 NUL 分隔、双 NUL 终止的字符串列表
// charSize: 1=ANSI 字节流, 2=UTF-16LE 码点流
function parseNulSeparatedList(buf: Buffer, charSize: 1 | 2): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i + charSize <= buf.length; i += charSize) {
    const code = charSize === 2 ? buf.readUInt16LE(i) : buf[i]
    if (code === 0) {
      if (cur) {
        out.push(cur)
        cur = ''
      } else {
        break // 双 NUL → 列表结束
      }
    } else {
      cur += String.fromCharCode(code)
    }
  }
  return out
}
