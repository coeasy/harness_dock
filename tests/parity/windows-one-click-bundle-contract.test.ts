import { describe, expect, it } from 'vitest'
import {
  resolveDesktopBuildTarget,
  tauriBundleArgument,
} from '../../scripts/build-targets.mjs'

describe('Windows one-click bundle contract', () => {
  it('packages Windows x64 as NSIS only and rejects unmodelled Windows targets', () => {
    const target = resolveDesktopBuildTarget('win32', 'x64')

    expect(target).toMatchObject({
      id: 'windows-x64',
      platform: 'win32',
      arch: 'x64',
      runtimeKey: 'win32-x64',
      bundles: ['nsis'],
      artifactKind: 'NSIS installer',
      ciRunner: 'windows-latest',
      installedStartupSmoke: true,
    })
    expect(tauriBundleArgument(target)).toBe('nsis')
    expect(() => resolveDesktopBuildTarget('win32', 'arm64')).toThrow(
      /unsupported local desktop build target win32-arm64/,
    )
  })
})
