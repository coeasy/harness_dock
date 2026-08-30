import { describe, expect, it } from 'vitest'
import { parseTauriRuntimeBridgeOptions } from '../bridge/options.ts'

describe('Tauri runtime bridge options', () => {
  it('accepts explicit full-runtime paths', () => {
    expect(
      parseTauriRuntimeBridgeOptions([
        '--origin',
        '/app/origin.json',
        '--plugin=/app/plugin/index.js',
        '--user-data',
        '/data/tauri',
        '--state-file',
        '/tmp/state.json',
        '--shutdown-file=/tmp/shutdown',
        '--packaged=true',
        '--bundled-root',
        '/app/dsh-runtime',
      ]),
    ).toEqual({
      originPath: '/app/origin.json',
      pluginPath: '/app/plugin/index.js',
      userDataDir: '/data/tauri',
      stateFile: '/tmp/state.json',
      shutdownFile: '/tmp/shutdown',
      packaged: true,
      bundledRoot: '/app/dsh-runtime',
    })
  })

  it('defaults packaged to false and rejects incomplete boot contracts', () => {
    expect(
      parseTauriRuntimeBridgeOptions([
        '--origin=o',
        '--plugin=p',
        '--user-data=u',
        '--state-file=s',
        '--shutdown-file=x',
      ]).packaged,
    ).toBe(false)
    expect(() => parseTauriRuntimeBridgeOptions(['--origin=o'])).toThrow(/--plugin/)
  })
})
