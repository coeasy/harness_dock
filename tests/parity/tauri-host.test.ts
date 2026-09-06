import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_PROFILES,
  TAURI_ANDROID_HOST_PROFILE,
  TAURI_HOST_PROFILE,
  TAURI_IOS_HOST_PROFILE,
} from '../../packages/bootstrap/src/index.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (relative: string) =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as Record<string, any>
const runNodeGate = (relative: string, args: string[] = []) =>
  spawnSync(process.execPath, [path.join(repoRoot, relative), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

const unsupportedNativeCurrent = [
  'notifications',
  'pushNotifications',
  'deepLinks',
  'secureCredentials',
  'backgroundExecution',
] as const

describe('Tauri product host contract', () => {
  it('publishes desktop as the stable local+remote host and mobile as remote-only', () => {
    expect(TAURI_HOST_PROFILE.channel).toBe('stable')
    expect(TAURI_HOST_PROFILE.capabilities.runtimes).toEqual(['local', 'remote'])
    expect(TAURI_HOST_PROFILE.capabilities.autoUpdate).toBe(true)
    expect(TAURI_HOST_PROFILE.capabilities.tray).toBe(true)
    expect(TAURI_IOS_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(TAURI_ANDROID_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(Object.keys(HOST_PROFILES)).toEqual(
      expect.arrayContaining(['tauri', 'tauri-ios', 'tauri-android']),
    )
    expect(Object.keys(HOST_PROFILES).some((key) => key.startsWith('perry'))).toBe(false)
  })

  it('does not advertise native services that the product has not implemented', () => {
    for (const capability of unsupportedNativeCurrent) {
      expect(TAURI_HOST_PROFILE.capabilities[capability]).toBe(false)
      expect(TAURI_IOS_HOST_PROFILE.capabilities[capability]).toBe(false)
      expect(TAURI_ANDROID_HOST_PROFILE.capabilities[capability]).toBe(false)
    }
  })

  it('keeps active product, release and shell identities aligned structurally', () => {
    const root = readJson('package.json')
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const release = readJson('release-manifest.json')
    const shell = readJson('packages/plugin-harness-shell/manifest.json')
    const shellContract = readJson('protocol/shell-contract.json')

    expect(tauri.version).toBe(root.version)
    expect(release.version).toBe(root.version)
    expect(release.shell.version).toBe(root.version)
    expect(shell.version).toBe(root.version)
    expect(release.shell.apiVersion).toBe(shellContract.apiVersion)
    expect(shell.apiVersion).toBe(shellContract.apiVersion)
    expect(shell.id).toBe(shellContract.pluginId)
    expect(tauri.identifier).toBe('com.harnessdock.client')
    expect(tauri.bundle.createUpdaterArtifacts).toBe(false)
    expect(tauri.bundle.windows.allowDowngrades).toBe(false)
  })

  it('keeps remote Harness, local control and mobile authority explicitly separated', () => {
    const harness = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    const control = readJson('apps/tauri/src-tauri/capabilities/local-main.json')
    const settings = readJson('apps/tauri/src-tauri/capabilities/shell-settings.json')
    const mobile = readJson('apps/tauri/src-tauri/capabilities/mobile-remote.json')

    expect(harness.local).toBe(false)
    expect(harness.windows).toEqual(['harness'])
    expect(harness.platforms).toEqual(['linux', 'macOS', 'windows'])
    expect(harness.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-start-dragging',
      'harness-shell',
      'host-protocol',
    ])
    expect(control.windows).toEqual(['control'])
    expect(control.remote).toBeUndefined()
    expect(settings.windows).toEqual(['settings'])
    expect(settings.remote).toBeUndefined()
    expect(mobile.platforms).toEqual(['android', 'iOS'])
    expect(mobile.windows).toEqual(['main'])
    expect(mobile.permissions).toEqual(['platform-info', 'gateway-health', 'gateway-pair'])
  })

  it('validates Tauri-only layout, mobile ACL and release semantics through their real gates', () => {
    for (const [relative, args] of [
      ['scripts/check-tauri-only.mjs', []],
      ['scripts/check-tauri-source-layout.mjs', []],
      ['scripts/check-mobile-contract.mjs', []],
      ['scripts/generate-shell-contract.mjs', ['--check']],
      ['scripts/generate-runtime-ready-contract.mjs', ['--check']],
      ['scripts/check-release.mjs', []],
    ] as const) {
      const result = runNodeGate(relative, [...args])
      expect(result.status, `${relative}\n${result.stdout}\n${result.stderr}`).toBe(0)
    }
  })

  it('keeps canonical branding and platform packaging configuration declarative', () => {
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const android = readJson('apps/tauri/src-tauri/tauri.android.conf.json')
    const ios = readJson('apps/tauri/src-tauri/tauri.ios.conf.json')

    expect(tauri.bundle.windows.nsis.installerIcon).toBe('icons/icon.ico')
    expect(tauri.bundle.windows.nsis.uninstallerIcon).toBe('icons/icon.ico')
    expect(tauri.bundle.windows.nsis.installMode).toBe('currentUser')
    expect(android.app.windows).toEqual([
      expect.objectContaining({ label: 'main', visible: true }),
    ])
    expect(ios.app.windows).toEqual([
      expect.objectContaining({ label: 'main', visible: true }),
    ])
  })
})
