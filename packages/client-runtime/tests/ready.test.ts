import { describe, expect, it } from 'vitest'
import { parseReadyFile } from '../src/ready.ts'

const expected = {
  dshVersion: '0.1.2-rc.1',
  pid: 42,
  generation: 7,
  nonce: 'nonce-7',
  imageIdentity: `sha256:${'a'.repeat(64)}`,
}

function ready(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    url: 'http://127.0.0.1:43123/?token=launch',
    host: '127.0.0.1',
    port: 43123,
    pid: 42,
    dshVersion: '0.1.2-rc.1',
    generation: 7,
    nonce: 'nonce-7',
    imageIdentity: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  })
}

describe('generation-bound ready.json', () => {
  it('accepts the exact managed process binding', () => {
    expect(parseReadyFile(ready(), expected)).toMatchObject(expected)
  })

  it('rejects stale generation, nonce, image identity, pid and version', () => {
    for (const [key, value] of [
      ['generation', 6],
      ['nonce', 'stale'],
      ['imageIdentity', `sha256:${'b'.repeat(64)}`],
      ['pid', 41],
      ['dshVersion', '0.1.1'],
    ] as const) {
      expect(parseReadyFile(ready({ [key]: value }), expected), key).toBeNull()
    }
  })

  it('rejects non-loopback, credentialed and mismatched-port URLs', () => {
    expect(parseReadyFile(ready({ host: '0.0.0.0' }), expected)).toBeNull()
    expect(parseReadyFile(ready({ url: 'http://127.0.0.2:43123/' }), expected)).toBeNull()
    expect(parseReadyFile(ready({ url: 'http://user:pass@127.0.0.1:43123/' }), expected)).toBeNull()
    expect(parseReadyFile(ready({ url: 'http://127.0.0.1:43124/' }), expected)).toBeNull()
    expect(parseReadyFile(ready({ url: 'https://127.0.0.1:43123/' }), expected)).toBeNull()
  })
})
