import { describe, expect, it } from 'vitest'
import { scrubElectronEnv } from '../src/env.ts'

describe('scrubElectronEnv', () => {
  it('drops Electron flags so vendored node.exe is not treated as Electron', () => {
    const cleaned = scrubElectronEnv({
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
    })
    expect(cleaned.PATH).toBe('/bin')
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(cleaned.ELECTRON_NO_ASAR).toBeUndefined()
  })
})
