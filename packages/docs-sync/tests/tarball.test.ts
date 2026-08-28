import { describe, expect, it } from 'vitest'
import { inspectPublishedPackage } from '../src/tarball.ts'

describe('inspectPublishedPackage', () => {
  it('rejects packages that have no dsh bin', () => {
    const result = inspectPublishedPackage({
      version: '0.0.1-rc.1',
      bin: undefined,
      dist: { fileCount: 3, integrity: 'sha512-aaa' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/bin/i)
  })

  it('rejects empty-shell tarballs even when bin is declared', () => {
    const result = inspectPublishedPackage({
      version: '0.0.1-rc.1',
      bin: { dsh: 'lib/bin.js' },
      dist: { fileCount: 2, integrity: 'sha512-aaa' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/empty|shell|fileCount/i)
  })

  it('accepts a real launcher package', () => {
    const result = inspectPublishedPackage({
      version: '0.1.1-rc.2',
      bin: { dsh: 'lib/bin.js' },
      dist: {
        fileCount: 20,
        integrity:
          'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==',
        tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz',
      },
    })
    expect(result).toEqual({
      ok: true,
      integrity:
        'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==',
      tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz',
    })
  })
})
