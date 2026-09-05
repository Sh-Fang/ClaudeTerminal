// Lucide 风格内联 SVG 图标：icon('plus') 的返回值直接塞 innerHTML；currentColor 继承父元素颜色

type IconName =
  | 'plus'
  | 'close'
  | 'chevron-down'
  | 'more-horizontal'
  | 'folder'
  | 'folder-filled'
  | 'rotate-ccw'
  | 'layers'
  | 'clock'
  | 'settings'
  | 'edit'
  | 'save'
  | 'trash'
  | 'sliders'
  | 'grip-vertical'
  | 'check-square'
  | 'square'
  | 'expand'
  | 'external-link'
  | 'expand-all'
  | 'collapse-all'
  | 'sticky-note'
  | 'eye'
  | 'eye-off'
  | 'arrow-left-right'

interface IconOpts {
  size?: number
  stroke?: number
}

function svg(body: string, opts: IconOpts = {}): string {
  const size = opts.size ?? 14
  const stroke = opts.stroke ?? 2
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  )
}

function svgFilled(body: string, opts: IconOpts = {}): string {
  const size = opts.size ?? 14
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="currentColor" stroke="none" aria-hidden="true">${body}</svg>`
  )
}

const PATHS: Record<IconName, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'more-horizontal': '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-filled': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  save:
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
    '<path d="M17 21v-8H7v8M7 3v5h8"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'grip-vertical': '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
  'check-square': '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  'expand-all': '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m4 8 2-2 2 2M4 16l2 2 2-2"/>',
  'collapse-all': '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m4 6 2 2 2-2M4 18l2-2 2 2"/>',
  'sticky-note': '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18"/><path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a16.4 16.4 0 0 1-3 4.1M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7c1.7 0 3.1-.5 4.4-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  'arrow-left-right': '<path d="m8 3-5 5 5 5"/><path d="M3 8h18"/><path d="m16 21 5-5-5-5"/><path d="M21 16H3"/>'
}

const FILLED: Partial<Record<IconName, true>> = {
  'folder-filled': true
}

export function icon(name: IconName, opts?: IconOpts): string {
  if (FILLED[name]) return svgFilled(PATHS[name], opts)
  return svg(PATHS[name], opts)
}
