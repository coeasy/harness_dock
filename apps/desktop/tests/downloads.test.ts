import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathIsWithin, sanitizeDownloadFilename, suggestedDownloadPath } from '../src/downloads.ts'

describe('download path safety', () => {
  it('keeps the filename inside the downloads directory', () => {
    expect(suggestedDownloadPath('C:/Users/me/Downloads', 'session.zip')).toBe(
      path.join('C:/Users/me/Downloads', 'session.zip'),
    )
  })

  it('strips path segments and platform-hostile filename characters', () => {
    expect(suggestedDownloadPath('C:/Users/me/Downloads', '..\\..\\windows\\session.zip')).toBe(
      path.join('C:/Users/me/Downloads', 'session.zip'),
    )
    expect(sanitizeDownloadFilename('bad<name>:?.zip')).toBe('bad_name___.zip')
    expect(sanitizeDownloadFilename('CON')).toBe('_CON')
  })

  it('rejects path traversal outside a workspace boundary', () => {
    const root = path.resolve('/workspace/project')
    expect(pathIsWithin(root, path.join(root, 'a', 'b.txt'))).toBe(true)
    expect(pathIsWithin(root, path.resolve(root, '..', 'secret.txt'))).toBe(false)
  })
})
