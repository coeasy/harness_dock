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
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const readJson = (relative: string): Record<string, any> => JSON.parse(read(relative))
const unsupportedNativeV02 = [
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
    expect(TAURI_HOST_PROFILE.capabilities.autoUpdate).toBe(true)
    expect(TAURI_HOST_PROFILE.capabilities.tray).toBe(true)
    expect(TAURI_HOST_PROFILE.capabilities.notifications).toBe(false)
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

  it('keeps repository, Tauri application, shell and Rust crate versions aligned', () => {
    const root = readJson('package.json')
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const releaseManifest = readJson('release-manifest.json')
    const shellManifest = readJson('packages/plugin-harness-shell/manifest.json')
    const cargo = read('apps/tauri/src-tauri/Cargo.toml')
    expect(root.version).toBe('0.2.0')
    expect(tauri.version).toBe(root.version)
    expect(releaseManifest.version).toBe(root.version)
    expect(releaseManifest.shell.version).toBe(root.version)
    expect(shellManifest.version).toBe(root.version)
    expect(cargo).toContain(`version = "${root.version}"`)
    expect(tauri.identifier).toBe('com.harnessdock.client')
  })

  it('keeps lib.rs as a composition root and desktop.rs as the native owner', () => {
    const host = read('apps/tauri/src-tauri/src/lib.rs')
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    expect(host).toContain('.setup(desktop::setup)')
    expect(host).toContain('app.run(desktop::handle_run_event)')
    expect(host).not.toContain('fn install_shell_menu(')
    expect(host).not.toContain('crate::tray::create_tray')
    expect(desktop).toContain('crate::host_kernel::install(app.handle().clone())')
    expect(desktop).toContain('match crate::tray::create_tray(&app.handle())')
    expect(desktop).toContain('tauri_plugin_updater::Builder::new().build()')
    expect(desktop).toContain('fn install_shell_menu(')
    expect(desktop).toContain('crate::startup::spawn(app.handle().clone())')
    expect(desktop).toContain('pub(crate) fn handle_run_event(')
    expect(desktop).toContain('RunEvent::ExitRequested')
    expect(desktop).toContain('api.prevent_exit()')
    expect(desktop).toContain('report_shell_error')
  })

  it('boots directly into isolated Harness Web while optional native features fail open', () => {
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const harnessWindow = read('apps/tauri/src-tauri/src/harness_window.rs')
    const web = read('apps/tauri/web/app.js')
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    expect(tauri.app.windows[0]).toMatchObject({
      label: 'splash',
      visible: true,
    })
    expect(tauri.app.windows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'control' })]),
    )
    expect(desktop).toContain('continuing without automatic install')
    expect(desktop).toContain('continuing with Harness Web')
    expect(startup).toContain('reconciler::ensure_runtime_for_boot')
    expect(startup).toContain('open_for_startup')
    expect(startup).toContain('show_startup_recovery')
    expect(startup).not.toContain('app.exit')
    expect(harnessWindow).toContain('window.set_decorations(true)')
    expect(harnessWindow).toContain('window.set_decorations(false)')
    expect(harnessWindow).toContain('schedule_harness_watchdog')
    expect(harnessWindow).toContain('show_startup_recovery')
    expect(web).toContain('Native startup owns the normal desktop path')
    expect(web).toContain('__harnessDockShowRecovery')
    expect(tray).toContain('app.get_webview_window("control")')
  })

  it('keeps every local control-page IPC entry registered and permitted', () => {
    const bridge = read('apps/tauri/src-tauri/src/bridge.rs')
    const build = read('apps/tauri/src-tauri/build.rs')
    const permissions = read('apps/tauri/src-tauri/permissions/harnessdock.toml')
    const web = read('apps/tauri/web/app.js')
    expect(web).toContain("call('runtime_status')")
    expect(web).toContain("call('shell_settings_show')")
    expect(bridge).toContain('$crate::runtime::runtime_status')
    expect(bridge).toContain('$crate::harness_window::shell_settings_show')
    expect(build).toContain('"host_execute"')
    expect(build).toContain('"host_snapshot"')
    expect(build).toContain('"diagnostics_close"')
    expect(build).toContain('"harness_shell_close"')
    expect(build).toContain('"runtime_status"')
    expect(build).toContain('"shell_settings_show"')
    expect(build).not.toContain('"app_quit"')
    expect(permissions).toContain('"runtime_status", "public_runtime_status"')
    expect(permissions).toContain('"shell_settings_show"]')
  })

  it('keeps the independent Harness Shell on demand and routes business actions through typed intents', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    const permission = read('apps/tauri/src-tauri/permissions/harnessdock.toml')
    const shell = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const shellAsset = read('packages/plugin-harness-shell/src/web/shell.js')
    const shellService = read('packages/plugin-harness-shell/src/index.ts')
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    expect(capability.windows).toEqual(['harness'])
    expect(capability.local).toBe(false)
    expect(capability.platforms).toEqual(['linux', 'macOS', 'windows'])
    expect(capability.remote.urls).toEqual([
      'http://127.0.0.1:*/*',
      'http://127.0.0.1:*',
    ])
    expect(capability.permissions).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-start-dragging',
      'harness-shell',
      'host-protocol',
    ])
    expect(permission).toContain('identifier = "harness-shell"')
    expect(shell).toContain('SHELL_WEB_SCRIPT')
    expect(shell).toContain("'window.close': 'harness_shell_close'")
    expect(shell).toContain("'runtime.safe-mode': 'start-safe-mode'")
    expect(shell).toContain("'gateway.manage': 'show-gateway'")
    expect(shellService).toContain("'gateway.manage'")
    expect(shellAsset).toContain('window.__DSH_SHELL_BRIDGE__')
    expect(shellAsset).toContain('setBusinessActionsDisabled')
    expect(desktop).toContain('workflow::HostIntent::StartSafeMode')
    expect(desktop).toContain('workflow::HostIntent::ShowGateway')
    expect(desktop).toContain('workflow::HostIntent::InstallUpdate')
    expect(tray).toContain('workflow::HostIntent::InstallUpdate')
    expect(tray).toContain('desktop::spawn_intent(app, intent)')
    expect(tray).not.toMatch(/=>\s*crate::update::update_install/)
  })

  it('keeps local control permissions isolated from remote Harness documents', () => {
    const capability = readJson('apps/tauri/src-tauri/capabilities/local-main.json')
    const remoteHarness = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    expect(capability.remote).toBeUndefined()
    expect(capability.windows).toEqual(['control'])
    expect(capability.permissions).not.toContain('harness-shell')
    expect(remoteHarness.local).toBe(false)
    expect(remoteHarness.windows).toEqual(['harness'])
    expect(remoteHarness.permissions).not.toContain('core:default')
  })

  it('keeps mobile a thin Remote Gateway client with no local Host/Runtime ownership', () => {
    const host = read('apps/tauri/src-tauri/src/lib.rs')
    const platform = read('apps/tauri/src-tauri/src/platform.rs')
    expect(host).toContain('#[cfg(not(mobile))]\nmod host_kernel;')
    expect(host).toContain('#[cfg(not(mobile))]\nmod runtime;')
    expect(host).toContain('#[cfg(not(mobile))]\nmod gateway_host;')
    expect(host).toContain('#[cfg(not(mobile))]\nmod update;')
    expect(host).toContain('#[cfg(mobile)]\n#[tauri::mobile_entry_point]')
    const mobileEntry = host.slice(host.indexOf('#[cfg(mobile)]\n#[tauri::mobile_entry_point]'))
    expect(mobileEntry).toContain('platform::platform_info')
    expect(mobileEntry).toContain('gateway::gateway_health')
    expect(mobileEntry).toContain('gateway::pair_gateway')
    expect(mobileEntry).not.toContain('bridge::handler!()')
    expect(mobileEntry).not.toContain('runtime::runtime_start')
    expect(mobileEntry).not.toContain('gateway_host::gateway_host_start')
    expect(platform).toContain('if cfg!(mobile) { "mobile" } else { "desktop" }')
    expect(platform).toContain('if cfg!(mobile) { "remote" } else { "local" }')
  })

  it('keeps managed helper execution child-local and console-safe', () => {
    const platform = read('apps/tauri/src-tauri/src/platform.rs')
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    expect(platform).toContain('command.env("PATH", joined)')
    expect(platform).not.toContain('env::set_var("PATH"')
    expect(platform).not.toContain('std::env::set_var("PATH"')
    expect(platform).toContain('command.process_group(0)')
    expect(platform).toContain('CREATE_NO_WINDOW')
    expect(runtime).toContain('platform::configure_child_command')
  })

  it('publishes full unsigned beta assets from the exact green main candidate', () => {
    const candidate = read('.github/workflows/tauri-candidate.yml')
    const release = read('.github/workflows/release.yml')
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    expect(candidate).toContain('Verify full runtime before packaging')
    expect(candidate).toContain('Confirm unsigned beta packaging')
    expect(candidate).not.toContain('@dsh/desktop')
    expect(release).not.toContain('-thin')
    expect(release).toContain('eq 15')
    expect(release).toContain('expected_tag="v${version}-beta.1"')
    expect(release).not.toContain('latest.json')
    expect(release).not.toContain('.app.tar.gz.sig')
    expect(release).toContain('candidate is stale:')
    expect(release).toContain('candidate is not green:')
    expect(release).toContain('no successful same-SHA main CI found')
    expect(release).toContain('published asset differs from exact candidate')
    expect(release).toContain('Immutable release asset matches')
    expect(release).not.toContain('--clobber')
    expect(release).not.toContain('--method DELETE')
    expect(tauri.bundle.createUpdaterArtifacts).toBe(false)
    expect(tauri.bundle.windows.allowDowngrades).toBe(false)
  })

  it('keeps canonical branding and release-mode Android packaging', () => {
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const candidate = read('.github/workflows/tauri-candidate.yml')
    const smoke = read('.github/workflows/tauri-ci.yml')
    const release = read('.github/workflows/release.yml')
    expect(tauri.bundle.windows.nsis.installerIcon).toBe('icons/icon.ico')
    expect(tauri.bundle.windows.nsis.uninstallerIcon).toBe('icons/icon.ico')
    expect(tauri.bundle.windows.nsis.installMode).toBe('currentUser')
    expect(candidate).toContain('run: pnpm prepare:icons')
    expect(candidate).toContain('cargo tauri android build --apk --aab')
    expect(smoke).toContain('cargo tauri android build --apk')
    expect(candidate).not.toContain('cargo tauri android build --release')
    expect(smoke).not.toContain('cargo tauri android build --release')
    expect(release).toContain('android-arm64-release.apk')
    expect(release).not.toContain('android-arm64-debug.apk')
  })
})
