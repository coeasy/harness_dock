import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')
const readJson = (relative: string) => JSON.parse(read(relative))

describe('Tauri shell fail-open guarantees', () => {
  it('never lets optional tray, updater or native-menu setup block Harness Web startup', () => {
    const host = read('apps/tauri/src-tauri/src/lib.rs')
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    expect(host).toContain('match tray::create_tray(&app.handle())')
    expect(host).toContain('tray_available')
    expect(host).toContain('continuing without automatic install')
    expect(host).toContain('continuing with Harness Web')
    expect(host).not.toContain('tray::create_tray(&app.handle())?')
    expect(host).not.toContain('install_shell_menu(&mut app).expect')
    expect(host).toContain('if !tray_available')
    expect(host).toContain('request_exit(app_handle)')
    expect(tray).not.toContain('default_window_icon().unwrap()')
    expect(tray).toContain('if let Some(icon) = app.default_window_icon()')
  })

  it('keeps the managed remote Harness IPC surface minimal and loopback-complete', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    expect(capability.local).toBe(false)
    expect(capability.windows).toEqual(['harness'])
    expect(capability.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-start-dragging',
      'harness-shell',
    ])
    expect(capability.remote.urls).toEqual(expect.arrayContaining([
      'http://127.0.0.1:*/*',
      'http://localhost:*/*',
      'http://[::1]:*/*',
      'https://127.0.0.1:*/*',
      'https://localhost:*/*',
      'https://[::1]:*/*',
    ]))
  })

  it('keeps the first-party shell plugin optional across registration and navigation', () => {
    const source = read('packages/plugin-harness-shell/src/index.ts')
    const bundle = read('packages/plugin-harness-shell/lib/index.js')
    const shell = read('packages/plugin-harness-shell/src/web/shell.js')
    const shellBundle = read('packages/plugin-harness-shell/web/shell.js')
    expect(source).toContain("register?.('harnessShell', service)")
    expect(source).toContain('registration error must fail open')
    expect(bundle).toContain('register?.("harnessShell", service)')
    expect(shell).toContain("window.addEventListener('pagehide'")
    expect(shellBundle).toBe(shell)
  })
})
