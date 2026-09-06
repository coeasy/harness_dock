import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (relative: string) =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'))

const harness = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
const control = readJson('apps/tauri/src-tauri/capabilities/local-main.json')
const settings = readJson('apps/tauri/src-tauri/capabilities/shell-settings.json')
const mobile = readJson('apps/tauri/src-tauri/capabilities/mobile-remote.json')

describe('Tauri capability boundaries', () => {
  it('keeps managed Harness Web remote-only and pinned to the exact loopback origin family', () => {
    expect(harness.local).toBe(false)
    expect(harness.platforms).toEqual(['linux', 'macOS', 'windows'])
    expect(harness.windows).toEqual(['harness'])
    expect(harness.remote.urls).toEqual([
      'http://127.0.0.1:*/*',
      'http://127.0.0.1:*',
    ])
    expect(harness.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-start-dragging',
      'harness-shell',
      'host-protocol',
    ])
  })

  it('does not grant Runtime/update/admin authority directly to Harness Web', () => {
    const denied = [
      'core:default',
      'runtime-start',
      'runtime-stop',
      'runtime-maintenance',
      'gateway-host',
      'update-check',
      'update-install',
      'shell-settings',
    ]
    for (const permission of denied) expect(harness.permissions).not.toContain(permission)
  })

  it('keeps local diagnostics surfaces label-scoped', () => {
    expect(control.windows).toEqual(['control'])
    expect(settings.windows).toEqual(['settings'])
    expect(control.remote).toBeUndefined()
    expect(settings.remote).toBeUndefined()
  })

  it('keeps mobile remote-only and unable to inherit desktop authority', () => {
    expect(mobile.platforms).toEqual(['android', 'iOS'])
    expect(mobile.windows).toEqual(['main'])
    expect(mobile.permissions).toEqual([
      'platform-info',
      'gateway-health',
      'gateway-pair',
    ])
  })
})
