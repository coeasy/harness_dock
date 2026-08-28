import { describe, expect, it } from 'vitest'
import { buildOrigin, diffOrigin } from '../src/origin.ts'

describe('buildOrigin', () => {
  it('records exact version, tag, commit, integrity, and docs hash', () => {
    const origin = buildOrigin({
      dshVersion: '0.1.1-rc.2',
      gitTag: 'dsh-v0.1.1-rc.2',
      gitCommit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
      npmIntegrity:
        'sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==',
      npmTarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz',
      docsHash: 'abc'.repeat(21) + 'abcd',
      clientVersion: '0.1.0',
      now: '2026-08-26T07:00:00.000Z',
    })
    expect(origin.dshVersion).toBe('0.1.1-rc.2')
    expect(origin.gitTag).toBe('dsh-v0.1.1-rc.2')
    expect(origin.clientVersion).toBe('0.1.0')
    expect(origin.syncedAt).toBe('2026-08-26T07:00:00.000Z')
  })
})

describe('diffOrigin', () => {
  it('reports when a newer exact version is available', () => {
    const current = buildOrigin({
      dshVersion: '0.1.1-rc.1',
      gitTag: 'dsh-v0.1.1-rc.1',
      gitCommit: 'aaa',
      npmIntegrity: 'sha512-a',
      npmTarball: 'https://example.invalid/a.tgz',
      docsHash: 'd'.repeat(64),
      clientVersion: '0.1.0',
      now: '2026-08-21T00:00:00.000Z',
    })
    const next = { ...current, dshVersion: '0.1.1-rc.2', gitTag: 'dsh-v0.1.1-rc.2' }
    const diff = diffOrigin(current, next)
    expect(diff.changed).toBe(true)
    expect(diff.fields).toContain('dshVersion')
  })
})
