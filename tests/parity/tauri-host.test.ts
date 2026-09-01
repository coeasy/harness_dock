import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOST_PROFILES, TAURI_ANDROID_HOST_PROFILE, TAURI_HOST_PROFILE, TAURI_IOS_HOST_PROFILE } from '../../packages/bootstrap/src/index.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (relative: string): Record<string, any> => JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'))
const unsupportedNativeV02 = ['autoUpdate', 'tray', 'notifications', 'pushNotifications', 'deepLinks', 'secureCredentials', 'backgroundExecution'] as const

describe('Tauri v0.2 host contract', () => {
  it('promotes Tauri desktop and mobile as stable product hosts', () => {
    expect(TAURI_HOST_PROFILE.channel).toBe('stable')
    expect(TAURI_HOST_PROFILE.capabilities.runtimes).toEqual(['local', 'remote'])
    expect(TAURI_IOS_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(TAURI_ANDROID_HOST_PROFILE.capabilities.runtimes).toEqual(['remote'])
    expect(Object.keys(HOST_PROFILES)).toEqual(expect.arrayContaining(['tauri', 'tauri-ios', 'tauri-android']))
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

  it('publishes Full-only Tauri assets while retaining thin as legacy source only', () => {
    const candidate = readFileSync(path.join(repoRoot, '.github/workflows/tauri-candidate.yml'), 'utf8')
    const release = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    const legacyDesktop = readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8')
    expect(candidate).toContain('Verify full runtime before packaging')
    expect(candidate).not.toContain('--scenario thin')
    expect(release).not.toContain('-thin')
    expect(release).toContain('expected 13 non-empty assets')
    expect(legacyDesktop).toContain('--scenario thin')
  })

  it('brands install, uninstall and mobile icon generation from one HarnessDock source', () => {
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const windows = tauri.bundle.windows
    expect(windows.allowDowngrades).toBe(false)
    expect(windows.webviewInstallMode).toEqual({ type: 'embedBootstrapper', silent: true })
    expect(windows.nsis.installerIcon).toBe('icons/icon.ico')
    expect(windows.nsis.uninstallerIcon).toBe('icons/icon.ico')
    expect(windows.nsis.installMode).toBe('currentUser')
    expect(windows.nsis.languages).toEqual(['English', 'SimpChinese', 'TradChinese'])

    const source = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/icons/app-icon.png'))
    expect(source.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(source.readUInt32BE(16)).toBe(1024)
    expect(source.readUInt32BE(20)).toBe(1024)

    const candidate = readFileSync(path.join(repoRoot, '.github/workflows/tauri-candidate.yml'), 'utf8')
    expect(candidate).toContain('cargo tauri icon src-tauri/icons/app-icon.png')
    expect(candidate).toContain('Verify Windows installer uses HarnessDock icon')
    expect(candidate).toContain('Replace default Android launcher icons with HarnessDock')
    expect(candidate).toContain('Replace default iOS app icons with HarnessDock')
  })

  it('publishes only after exact successful main candidate and same-SHA CI', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('workflow_run:')
    expect(workflow).toContain('- tauri-candidate')
    expect(workflow).toContain('candidate is stale:')
    expect(workflow).toContain('candidate is not green:')
    expect(workflow).toContain('no successful same-SHA main CI found')
    expect(workflow).toContain('gh release upload "$RELEASE_TAG" release-assets/* --clobber')
    expect(workflow).toContain('test "$tag_sha" = "$RELEASE_SHA"')
    expect(workflow).not.toContain('--method DELETE')
  })

  it('builds Android candidates in release mode and gates native package size', () => {
    const candidate = readFileSync(path.join(repoRoot, '.github/workflows/tauri-candidate.yml'), 'utf8')
    const smoke = readFileSync(path.join(repoRoot, '.github/workflows/tauri-ci.yml'), 'utf8')
    const release = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    const sizeGate = readFileSync(path.join(repoRoot, 'scripts/check-android-package.mjs'), 'utf8')
    expect(candidate).toContain('cargo tauri android build --apk --aab')
    expect(candidate).not.toContain('cargo tauri android build --release')
    expect(candidate).toContain('node scripts/check-android-package.mjs')
    expect(smoke).toContain('cargo tauri android build --apk')
    expect(smoke).not.toContain('cargo tauri android build --release')
    expect(release).toContain('android-arm64-release.apk')
    expect(release).not.toContain('android-arm64-debug.apk')
    expect(sizeGate).toContain('.so')
  })

  it('never grants remote Harness/Gateway documents local Tauri IPC permissions', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/local-main.json')
    expect(capability.remote).toBeUndefined()
    expect(capability.windows).toEqual(['main'])
  })

  it('boots directly into the isolated Harness WebView on desktop', () => {
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const android = readJson('apps/tauri/src-tauri/tauri.android.conf.json')
    const ios = readJson('apps/tauri/src-tauri/tauri.ios.conf.json')
    expect(tauri.app.windows[0].visible).toBe(false)
    expect(android.app.windows[0].visible).toBe(true)
    expect(ios.app.windows[0].visible).toBe(true)

    const launcher = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/main.rs'), 'utf8')
    const harnessWindow = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/harness_window.rs'), 'utf8')
    const host = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/lib.rs'), 'utf8')
    const runtime = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/runtime.rs'), 'utf8')
    const web = readFileSync(path.join(repoRoot, 'apps/tauri/web/app.js'), 'utf8')
    expect(launcher).toContain('windows_subsystem = "windows"')
    expect(harnessWindow).toContain('let _ = control.hide()')
    expect(harnessWindow).toContain('control_show')
    expect(harnessWindow).toContain('.decorations(false)')
    expect(host).toContain('tray::create_tray')
    expect(host).toContain('RunEvent::WindowEvent')
    expect(host).toContain('quitting')
    expect(host).toContain('runtime_starting')
    expect(host).toContain('web_action')
    expect(host).toContain('spawn_blocking')
    expect(host).toContain('starting_processes_empty')
    expect(host).not.toContain('prewarm_settings_window')
    expect(runtime).toContain('gateway_host::stop_managed(&state.gateway)')
    expect(runtime).toContain('runtime_restarting')
    expect(web).toContain('autoStartDesktopRuntime')
    expect(web).toContain("call('runtime_start')")
    expect(web).toContain("call('harness_open'")
  })

  it('keeps the Shell Settings plugin on demand while Harness Web is mandatory', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    const permission = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/permissions/harnessdock.toml'), 'utf8')
    const shell = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/harness_shell.rs'), 'utf8')
    const harnessWindow = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/harness_window.rs'), 'utf8')
    const web = readFileSync(path.join(repoRoot, 'apps/tauri/web/app.js'), 'utf8')
    const index = readFileSync(path.join(repoRoot, 'apps/tauri/web/index.html'), 'utf8')
    const settingsCapability = readJson('apps/tauri/src-tauri/capabilities/shell-settings.json')
    const settingsHtml = readFileSync(path.join(repoRoot, 'apps/tauri/web/settings.html'), 'utf8')
    const settingsJs = readFileSync(path.join(repoRoot, 'apps/tauri/web/settings.js'), 'utf8')
    expect(capability.windows).toEqual(['harness'])
    expect(capability.local).toBe(false)
    expect(capability.platforms).toEqual(['linux', 'macOS', 'windows'])
    expect(capability.remote.urls).toEqual([
      'http://127.0.0.1:*/**',
      'http://localhost:*/**',
      'https://127.0.0.1:*/**',
      'https://localhost:*/**',
    ])
    expect(capability.permissions).toContain('harness-shell')
    expect(readJson('apps/tauri/src-tauri/capabilities/local-main.json').permissions).not.toContain('harness-shell')
    expect(permission).toContain('commands.allow = ["shell_settings_show", "harness_minimize", "harness_toggle_maximize", "harness_window_state", "harness_close", "harness_reload_web", "harness_restart_web"]')
    expect(shell).toContain("shell_settings_show")
    expect(shell).toContain("harness_reload_web")
    expect(shell).toContain("harness_restart_web")
    expect(shell).toContain('harnessdock-shell-mounted')
    expect(shell).toContain('padding-bottom:var(--harnessdock-shell-bottom-inset)!important')
    expect(shell).toContain('overflow-x:auto')
    expect(web).toContain("await openHarnessWithRetry(currentRuntime.appUrl)")
    expect(web).not.toContain('autoOpenHarness')
    expect(web).not.toContain('auto-open-harness')
    expect(index).not.toContain('id="shell-settings"')
    expect(index).toContain('正常启动将直接打开 Harness Web')
    expect(index).toContain('id="desktop-card" class="card hidden"')
    expect(settingsCapability.windows).toEqual(['settings'])
    expect(settingsCapability.permissions).toContain('shell-settings')
    expect(permission).toContain('identifier = "runtime-maintenance"')
    expect(permission).toContain('identifier = "shell-settings"')
    expect(settingsHtml).toContain('Web 优先启动')
    expect(harnessWindow).toContain('pub async fn shell_settings_show')
    expect(harnessWindow).toContain('pub fn control_hide')
    expect(readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/build.rs'), 'utf8')).toContain('"control_hide"')
    expect(harnessWindow).toContain('async fn show_settings_window')
    expect(harnessWindow).toContain('.visible(false)')
    expect(harnessWindow).toContain('PageLoadEvent::Finished')
    expect(harnessWindow).not.toContain('eval("window.location.reload()")')
    expect(settingsJs).toContain('const invoke = window.__TAURI__?.core?.invoke')
    expect(settingsJs).toContain("call('harness_restart_web')")
    expect(settingsJs).toContain("call('harness_reload_web')")
    expect(settingsJs).toContain("call('shell_settings_close')")
    expect(settingsJs).toContain("call('update_check')")
    expect(settingsHtml).toContain('版本更新')
    expect(settingsHtml).toContain('id="settings-quit"')
    expect(web).toContain('openHarnessWithRetry')
    expect(web).toContain("await call('control_hide')")
  })

  it('keeps Windows helper processes console-free and has a final Web UI safe profile', () => {
    const platform = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/platform.rs'), 'utf8')
    const runtime = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/runtime.rs'), 'utf8')
    const gatewayHost = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs'), 'utf8')
    expect(platform).toContain('CREATE_NO_WINDOW')
    expect(runtime).toContain('platform::configure_child_command')
    expect(gatewayHost).toContain('platform::configure_child_command')
    expect(runtime).toContain('--dump-default-config')
    expect(runtime).toContain('start_safe_profile')
    expect(runtime).toContain('start_with_node_fallback')
    expect(runtime).toContain('内置 Node')
    expect(runtime).toContain('safe-dsh-home')
    expect(runtime).toContain('recovery_source: "safe-profile"')
  })

  it('declares mobile as remote-runtime-only in the Rust launcher UI contract', () => {
    const source = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/platform.rs'), 'utf8')
    expect(source).toContain('if cfg!(mobile) { "remote" } else { "local" }')
    const runtime = readFileSync(path.join(repoRoot, 'apps/tauri/src-tauri/src/runtime.rs'), 'utf8')
    expect(runtime).toContain('if cfg!(mobile)')
    expect(runtime).toContain('不允许在移动设备内启动桌面 dsh Runtime')
  })
})
