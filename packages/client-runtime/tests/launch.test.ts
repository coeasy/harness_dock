import { pathToFileURL } from 'node:url'
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
    expect(yaml).toContain(pathToFileURL('/opt/harnessdock/plugin-embedded-client/index.js').href)
  })

  it('adds the legacy client-runtime compatibility row when provided', () => {
    const yaml = renderEmbeddedPatch(
      '/opt/harnessdock/plugin-embedded-client/index.js',
      '/opt/harnessdock/dsh-client-runtime-compat/index.js',
    )
    expect(yaml).toContain('id: harnessdock-client-runtime-compat')
    expect(yaml).toContain(
      pathToFileURL('/opt/harnessdock/dsh-client-runtime-compat/index.js').href,
    )
  })

  it('adds the independent Harness Shell row when provided', () => {
    const yaml = renderEmbeddedPatch(
      '/opt/harnessdock/plugin-embedded-client/index.js',
      undefined,
      '/opt/harnessdock/plugin-harness-shell/lib/index.js',
    )
    expect(yaml).toContain('id: harness-shell')
    expect(yaml).toContain(
      pathToFileURL('/opt/harnessdock/plugin-harness-shell/lib/index.js').href,
    )
  })
})
