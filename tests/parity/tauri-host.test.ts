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
    const web = readFileSync(path.join(repoRoot, 'apps/tauri/web/app.js'), 'utf8')
    expect(launcher).toContain('windows_subsystem = "windows"')
    expect(harnessWindow).toContain('let _ = control.hide()')
    expect(harnessWindow).toContain('control_show')
    expect(web).toContain('autoStartDesktopRuntime')
    expect(web).toContain("call('runtime_start')")
    expect(web).toContain("call('harness_open'")
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
