import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resourceRoot } from '../src/paths.ts'

describe('Perry resource paths', () => {
  it('uses a sibling resources directory on Windows/Linux', () => {
    expect(resourceRoot('C:\\Apps\\HarnessDock\\HarnessDock-Native-Preview.exe', 'win32', {})).toBe(
      path.win32.join('C:\\Apps\\HarnessDock', 'resources'),
    )
    expect(resourceRoot('/opt/harnessdock/harnessdock-native-preview', 'linux', {})).toBe(
      '/opt/harnessdock/resources',
    )
  })

  it('uses Contents/Resources inside a macOS app bundle', () => {
    expect(
      resourceRoot(
        '/Applications/HarnessDock Native Preview.app/Contents/MacOS/HarnessDock-Native-Preview',
        'darwin',
        {},
      ),
    ).toBe('/Applications/HarnessDock Native Preview.app/Contents/Resources')
  })

  it('accepts an explicit resource override for development and diagnostics', () => {
    expect(resourceRoot('/tmp/app', 'linux', { HARNESSDOCK_RESOURCE_DIR: './fixtures/resources' })).toBe(
      path.resolve('./fixtures/resources'),
    )
  })
})
