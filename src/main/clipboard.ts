import { clipboard } from 'electron'

// 剪贴板读取：Windows 复制文件后是 CF_HDROP（DROPFILES 头：offset@0、fWide@16、
// payload@20 为 NUL 分隔双 NUL 终止的路径列表）。优先解析文件路径，退化为纯文本。

export type ClipboardRead =
  | { kind: 'files'; files: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

const DROPFILES_HEADER_BYTES = 20
const OFFSET_FIELD_OFFSET = 0
const FWIDE_FIELD_OFFSET = 16

export function readClipboardSelection(): ClipboardRead {
  // 优先 CF_HDROP（多文件）；某些 Electron/Windows 组合下它返回空 buffer，兜底 FileNameW（单文件）。
  let files = readDropFiles()
  if (files.length === 0) files = readSingleFileName()
  if (files.length > 0) return { kind: 'files', files }
  const text = clipboard.readText()
  if (text) return { kind: 'text', text }
  return { kind: 'empty' }
}

// 兜底：FileNameW（UTF-16LE）直接读 buffer 自行解码避免中文乱码；再退化 ANSI FileName。
function readSingleFileName(): string[] {
  if (process.platform !== 'win32') return []
  try {
    const buf = clipboard.readBuffer('FileNameW')
    if (buf && buf.length >= 2) {
      const evenLen = buf.length - (buf.length % 2)
      const s = buf.subarray(0, evenLen).toString('utf16le').replace(/\0+$/g, '').trim()
      if (s) return [s]
    }
  } catch {}
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

function readDropFiles(): string[] {
  if (process.platform !== 'win32') return []
  try {
    // 不用 availableFormats() 预筛选：它可能返回 MIME 名而非 CF_HDROP，会误判；直接 readBuffer 试。
    let buf: Buffer | undefined
    try { buf = clipboard.readBuffer('CF_HDROP') } catch {}
    if (!buf || buf.length < DROPFILES_HEADER_BYTES) return []
    const offset = buf.readUInt32LE(OFFSET_FIELD_OFFSET)
    const fWide = buf.readUInt32LE(FWIDE_FIELD_OFFSET) !== 0
    if (offset >= buf.length) return []
    const payload = buf.slice(offset)
    if (fWide) {
      // UTF-16LE 一次性解码（正确处理 surrogate pair）；资源管理器复制文件走这条路
      const evenLen = payload.length - (payload.length % 2)
      return payload
        .subarray(0, evenLen)
        .toString('utf16le')
        .split('\0')
        .filter((s) => s.length > 0)
    }
    // ANSI 分支极少见；Node 不支持 GBK，按单字节退化解码（非 ASCII 会乱码但不崩）
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
