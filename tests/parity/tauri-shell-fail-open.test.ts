import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')
const readJson = (relative: string) => JSON.parse(read(relative))

describe('Tauri shell fail-open guarantees', () => {
  it('never lets optional tray, updater or native-menu setup block Harness Web startup', () => {
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    expect(desktop).toContain('match crate::tray::create_tray(&app.handle())')
    expect(desktop).toContain('tray_available')
    expect(desktop).toContain('continuing without automatic install')
    expect(desktop).toContain('continuing with Harness Web')
    expect(desktop).not.toContain('crate::tray::create_tray(&app.handle())?')
    expect(desktop).not.toContain('install_shell_menu(app)?')
    expect(desktop).toContain('crate::startup::spawn(app.handle().clone())')
    expect(desktop).toContain('RunEvent::WindowEvent')
    expect(desktop).toContain('crate::supervisor::request_exit(app_handle)')
    expect(tray).not.toContain('default_window_icon().unwrap()')
    expect(tray).toContain('if let Some(icon) = app.default_window_icon()')
  })

  it('keeps the managed remote Harness IPC surface minimal and aligned with the exact Runtime origin', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    const permissions = read('apps/tauri/src-tauri/permissions/harnessdock.toml')
    expect(capability.local).toBe(false)
    expect(capability.windows).toEqual(['harness'])
    expect(capability.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-start-dragging',
      'harness-shell',
    ])
    expect(capability.remote.urls).toEqual([
      'http://127.0.0.1:*/*',
      'http://127.0.0.1:*',
    ])
    expect(capability.remote.urls.every((url: string) => url.startsWith('http://127.0.0.1:'))).toBe(true)
    expect(permissions).toContain('identifier = "harness-shell"')
    expect(permissions).toContain('"control_show"')
    const harnessShellPermission = permissions.split('identifier = "harness-shell"')[1]?.split('[[permission]]')[0] || ''
    expect(harnessShellPermission).not.toContain('gateway_host_')
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

  it('falls back to native window controls when the optional shell cannot be installed', () => {
    const harnessWindow = read('apps/tauri/src-tauri/src/harness_window.rs')
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const shellService = read('packages/plugin-harness-shell/src/index.ts')
    const shellBundle = read('packages/plugin-harness-shell/lib/index.js')
    expect(harnessWindow).toContain('window.set_decorations(true)')
    expect(harnessWindow).toContain('window.set_decorations(false)')
    expect(harnessWindow).toContain('http://127.0.0.1:<port> Runtime')
    expect(runtime).toContain('app_url.scheme() != "http"')
    expect(shellService).toContain("'gateway.manage'")
    expect(shellBundle).toContain('"gateway.manage"')
  })

  it('keeps the packaged Runtime environment child-only instead of mutating the Host PATH', () => {
    const platform = read('apps/tauri/src-tauri/src/platform.rs')
    expect(platform).toContain('fn embedded_runtime_root')
    expect(platform).toContain('tools').toBeTruthy()
    expect(platform).toContain('command.env("PATH", joined)')
    expect(platform).toContain('configure_child_command')
    expect(platform).toContain('command.process_group(0)')
    expect(platform).toContain('CREATE_NO_WINDOW')
    expect(platform).not.toContain('env::set_var("PATH"')
    expect(platform).not.toContain('std::env::set_var("PATH"')
  })
})
