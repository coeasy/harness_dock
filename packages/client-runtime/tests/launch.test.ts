import { describe, expect, it } from 'vitest'
import { buildLaunchArgs, renderEmbeddedPatch } from '../src/launch.ts'

describe('buildLaunchArgs', () => {
  it('always binds loopback, random port, and --no-open', () => {
    expect(
      buildLaunchArgs({
        patchFile: 'D:/tmp/embedded.patch.yml',
      }),
    ).toEqual([
      '--profile',
      'web',
      '--patch',
      'D:/tmp/embedded.patch.yml',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ])
  })
})

describe('renderEmbeddedPatch', () => {
  it('inserts the plugin by absolute path', () => {
    const yaml = renderEmbeddedPatch('D:/work/plugin-embedded-client/src/index.ts')
    expect(yaml).toContain('id: embedded-client')
    expect(yaml).toContain('D:/work/plugin-embedded-client/src/index.ts')
    expect(yaml).toContain('- insert:')
  })
})
