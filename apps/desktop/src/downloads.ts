import path from 'node:path'

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function sanitizeDownloadFilename(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, '/'))
  let safe = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!safe || safe === '.' || safe === '..') safe = 'download.bin'
  if (RESERVED_WINDOWS_NAMES.test(safe)) safe = `_${safe}`
  if (safe.length > 180) {
    const ext = path.extname(safe).slice(0, 24)
    const stem = path.basename(safe, path.extname(safe)).slice(0, Math.max(1, 180 - ext.length))
    safe = `${stem}${ext}`
  }
  return safe
}

export function suggestedDownloadPath(downloadsDir: string, filename: string): string {
  return path.join(downloadsDir, sanitizeDownloadFilename(filename))
}

export function pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
