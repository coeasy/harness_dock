import { describe, expect, it } from 'vitest'
import {
  releaseArtifactName,
  runtimeNodeRelative,
  tauriBundleKinds,
} from '../scripts/pack-plan.mjs'

describe('Tauri full package plan', () => {
  it('uses installable formats on every desktop OS', () => {
    expect(tauriBundleKinds('win32')).toEqual(['nsis'])
    expect(tauriBundleKinds('darwin')).toEqual(['dmg'])
    expect(tauriBundleKinds('linux')).toEqual(['appimage', 'deb'])
  })

  it('uses the bundled Node layout shared with client-runtime', () => {
    expect(runtimeNodeRelative('win32')).toBe('node.exe')
    expect(runtimeNodeRelative('darwin')).toBe('bin/node')
    expect(runtimeNodeRelative('linux')).toBe('bin/node')
  })

  it('creates stable public-facing full package names', () => {
    expect(
      releaseArtifactName({ version: '0.2.0', platform: 'win32', arch: 'x64', extension: '.exe' }),
    ).toBe('HarnessDock-0.2.0-windows-x64-full-setup.exe')
    expect(
      releaseArtifactName({ version: '0.2.0', platform: 'darwin', arch: 'arm64', extension: '.dmg' }),
    ).toBe('HarnessDock-0.2.0-macos-arm64-full.dmg')
    expect(
      releaseArtifactName({ version: '0.2.0', platform: 'linux', arch: 'x64', extension: '.AppImage' }),
    ).toBe('HarnessDock-0.2.0-linux-x64-full.AppImage')
  })
})
