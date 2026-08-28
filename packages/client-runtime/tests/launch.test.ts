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
  it('renders an encoded file URL for Windows install paths', () => {
    const yaml = renderEmbeddedPatch('C:\\Program Files\\HarnessDock\\resources\\plugin-embedded-client\\index.js')
    expect(yaml).toContain('id: embedded-client')
    expect(yaml).toContain('file:///C:/Program%20Files/HarnessDock/resources/plugin-embedded-client/index.js')
    expect(yaml).toContain('- insert:')
  })

  it('keeps ordinary POSIX paths importable', () => {
    const yaml = renderEmbeddedPatch('/opt/harnessdock/plugin-embedded-client/index.js')
    expect(yaml).toContain('file:///opt/harnessdock/plugin-embedded-client/index.js')
  })
})
