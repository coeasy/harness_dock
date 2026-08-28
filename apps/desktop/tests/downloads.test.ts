import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { suggestedDownloadPath } from '../src/downloads.ts'

describe('suggestedDownloadPath', () => {
  it('keeps the filename inside the downloads directory', () => {
    expect(suggestedDownloadPath('C:/Users/me/Downloads', 'session.zip')).toBe(
      path.join('C:/Users/me/Downloads', 'session.zip'),
    )
  })

  it('strips path segments from a hostile filename', () => {
    expect(suggestedDownloadPath('C:/Users/me/Downloads', '..\\..\\windows\\session.zip')).toBe(
      path.join('C:/Users/me/Downloads', 'session.zip'),
    )
  })
})
