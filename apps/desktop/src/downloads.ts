import path from 'node:path'

export function suggestedDownloadPath(downloadsDir: string, filename: string): string {
  const base = path.basename(filename.replace(/\\/g, '/'))
  const safe = base.length > 0 ? base : 'download.bin'
  return path.join(downloadsDir, safe)
}
