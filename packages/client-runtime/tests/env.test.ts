import { describe, expect, it } from 'vitest'
import { scrubElectronEnv } from '../src/env.ts'

describe('scrubElectronEnv', () => {
  it('drops inherited Electron flags for standalone vendored Node', () => {
    const cleaned = scrubElectronEnv({
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
    })
    expect(cleaned.PATH).toBe('/bin')
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(cleaned.ELECTRON_NO_ASAR).toBeUndefined()
  })

  it('preserves an explicitly requested Electron-as-Node child launch', () => {
    const cleaned = scrubElectronEnv({
      ELECTRON_RUN_AS_NODE: '1',
      DSH_PRESERVE_ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
    })
    expect(cleaned.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(cleaned.DSH_PRESERVE_ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(cleaned.ELECTRON_NO_ASAR).toBeUndefined()
  })
})
