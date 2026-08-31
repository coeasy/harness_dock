import { readFileSync } from 'node:fs'
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

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as Record<string, unknown>
}

const unsupportedNativeV02 = [
  'autoUpdate',
  'tray',
  'notifications',
  'pushNotifications',
  'deepLinks',
  'secureCredentials',
  'backgroundExecution',
] as const

describe('Tauri v0.2 host contract', () => {
  it('promotes Tauri desktop and mobile as stable product hosts', () => {
    expect(TAURI_HOST_PROFILE.channel).toBe('stable')
    expect(TAURI_HOST_PROFILE.capabilities.runtimes).toEqual(['local', 'remote'])
    expect(TAURI_IOS_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(TAURI_ANDROID_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(Object.keys(HOST_PROFILES)).toEqual(
      expect.arrayContaining(['tauri', 'tauri-ios', 'tauri-android']),
    )
    expect(Object.keys(HOST_PROFILES).some((key) => key.startsWith('perry'))).toBe(false)
  })

  it('does not advertise native services that v0.2 has not implemented', () => {
    for (const capability of unsupportedNativeV02) {
      expect(TAURI_HOST_PROFILE.capabilities[capability]).toBe(false)
      expect(TAURI_IOS_HOST_PROFILE.capabilities[capability]).toBe(false)
      expect(TAURI_ANDROID_HOST_PROFILE.capabilities[capability]).toBe(false)
    }
  })

  it('keeps repository, Tauri application and Rust crate versions aligned', () => {
    const root = readJson('package.json')
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const cargo = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/Cargo.toml'), 'utf8')
    expect(tauri.version).toBe(root.version)
    expect(cargo).toContain(`version = "${root.version}"`)
    expect(tauri.identifier).toBe('com.harnessdock.client')
  })

  it('publishes only after an exact successful main Tauri candidate', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('workflow_run:')
    expect(workflow).toContain('- tauri-candidate')
    expect(workflow).toContain('candidate is stale:')
    expect(workflow).toContain('candidate is not green:')
    expect(workflow).toContain('refusing to overwrite')
    expect(workflow).toContain('target_commitish: ${{ steps.release.outputs.sha }}')
    expect(workflow).not.toMatch(/\npush:\s*\n\s*tags:/)
  })

  it('never grants remote Harness/Gateway documents local Tauri IPC permissions', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/local-main.json')
    expect(capability.remote).toBeUndefined()
    expect(capability.windows).toEqual(['main'])
    const raw = readFileSync(
      path.join(repoRoot, 'apps/tauri/src-tauri/capabilities/local-main.json'),
      'utf8',
    )
    expect(raw).not.toContain('"remote"')
  })

  it('declares mobile as remote-runtime-only in the Rust launcher UI contract', () => {
    const source = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/platform.rs'), 'utf8')
    expect(source).toContain('if cfg!(mobile) { "remote" } else { "local" }')
    const runtime = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/runtime.rs'), 'utf8')
    expect(runtime).toContain('if cfg!(mobile)')
    expect(runtime).toContain('不允许在移动设备内启动桌面 dsh Runtime')
  })
})
