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
  const files = readDropFiles()
  if (files.length > 0) return { kind: 'files', files }
  const text = clipboard.readText()
  if (text) return { kind: 'text', text }
  return { kind: 'empty' }
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
    const formats = clipboard.availableFormats()
    if (!formats.includes('CF_HDROP') && !formats.some((f) => /FileName/i.test(f))) return []
    let buf: Buffer | undefined
    try { buf = clipboard.readBuffer('CF_HDROP') } catch {}
    if (!buf || buf.length < DROPFILES_HEADER_BYTES) return []
    const offset = buf.readUInt32LE(OFFSET_FIELD_OFFSET)
    const fWide = buf.readUInt32LE(FWIDE_FIELD_OFFSET) !== 0
    if (offset >= buf.length) return []
    const payload = buf.slice(offset)
    return parseNulSeparatedList(payload, fWide ? 2 : 1)
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
