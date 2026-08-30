import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_RELEASE_HOST,
  ELECTRON_HOST_PROFILE,
  HOST_PROFILES,
  PERRY_ANDROID_HOST_PROFILE,
  PERRY_DESKTOP_HOST_PROFILE,
  TAURI_ANDROID_HOST_PROFILE,
  TAURI_DESKTOP_HOST_PROFILE,
  TAURI_IOS_HOST_PROFILE,
  isDefaultReleaseHost,
  supportsRuntime,
} from '../src/host-capabilities.ts'

describe('host capability contract', () => {
  it('makes Tauri the v0.2 default release host without demoting Electron stability', () => {
    expect(DEFAULT_DESKTOP_RELEASE_HOST).toBe('tauri-desktop')
    expect(TAURI_DESKTOP_HOST_PROFILE).toMatchObject({ channel: 'next', releaseRole: 'default' })
    expect(ELECTRON_HOST_PROFILE).toMatchObject({ channel: 'stable', releaseRole: 'compatibility' })
    expect(PERRY_DESKTOP_HOST_PROFILE).toMatchObject({
      channel: 'experimental',
      releaseRole: 'experimental',
    })
    expect(isDefaultReleaseHost(TAURI_DESKTOP_HOST_PROFILE)).toBe(true)
    expect(isDefaultReleaseHost(ELECTRON_HOST_PROFILE)).toBe(false)
  })

  it('keeps desktop local runtimes and mobile remote runtimes separated', () => {
    expect(supportsRuntime(ELECTRON_HOST_PROFILE, 'local')).toBe(true)
    expect(supportsRuntime(TAURI_DESKTOP_HOST_PROFILE, 'local')).toBe(true)
    expect(supportsRuntime(PERRY_DESKTOP_HOST_PROFILE, 'local')).toBe(true)
    expect(supportsRuntime(TAURI_IOS_HOST_PROFILE, 'local')).toBe(false)
    expect(supportsRuntime(TAURI_IOS_HOST_PROFILE, 'remote')).toBe(true)
    expect(supportsRuntime(TAURI_ANDROID_HOST_PROFILE, 'remote')).toBe(true)
    expect(supportsRuntime(PERRY_ANDROID_HOST_PROFILE, 'remote')).toBe(true)
  })

  it('has an explicit profile for every host id', () => {
    expect(Object.keys(HOST_PROFILES).sort()).toEqual([
      'electron',
      'perry-android',
      'perry-desktop',
      'perry-ios',
      'tauri-android',
      'tauri-desktop',
      'tauri-ios',
      'vscode',
    ])
  })

  it('does not advertise unimplemented Tauri native services yet', () => {
    expect(TAURI_DESKTOP_HOST_PROFILE.capabilities).toMatchObject({
      downloads: false,
      filePicker: false,
      nativeJsBridge: false,
      autoUpdate: false,
      tray: false,
      notifications: false,
    })
  })
})
