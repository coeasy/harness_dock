import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('plugin isolation and Rescue Web contract', () => {
  it('binds persisted quarantine to the exact Runtime image and launch scope', () => {
    const quarantine = read('apps/tauri/src-tauri/src/plugin_quarantine.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')

    expect(quarantine).toContain('const SCHEMA_VERSION: u8 = 4')
    expect(quarantine).toContain('pub runtime_image_identity: String')
    expect(quarantine).toContain('record.dsh_version == dsh_version')
    expect(quarantine).toContain('record.runtime_image_identity == runtime_image_identity')
    expect(quarantine).toContain('record.launch_scope == launch_scope')
    expect(quarantine).toContain('exact_prerelease_change_invalidates_quarantine')
    expect(quarantine).toContain('runtime_image_change_invalidates_quarantine')
    expect(start).toContain('&image.origin.dsh_version,\n            &image.image_identity,')
    expect(start).toContain('&image.origin.dsh_version,\n                        &image.image_identity,')
  })

  it('uses the upstream id-targeted disabled overlay and preserves HarnessDock integrations', () => {
    const config = read('apps/tauri/src-tauri/src/runtime/config.rs')
    const safeMode = read('apps/tauri/src-tauri/src/runtime/safe_mode.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')

    expect(config).toContain('disabled: true')
    expect(config).toContain('recovery_never_targets_official_or_embedded_rows')
    expect(safeMode).toContain('HARNESSDOCK_INTEGRATION_IDS')
    expect(safeMode).toContain('!is_official_source(&row.source)')
    expect(start).toContain('let safe_home = dir.join("rescue-dsh-home")')
    expect(start).toContain('Some(&safe_home)')
    expect(start).toContain('"rescue-private-home"')
  })

  it('routes operator isolation and restore through one HostKernel/Reconciler path', () => {
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window/window.rs')
    const settings = read('apps/tauri/web/settings.js')

    expect(reconciler).toContain('HostCommand::StartSafeMode')
    expect(reconciler).toContain('harness_safe_mode_restart')
    expect(reconciler).toContain('HostCommand::ClearQuarantine')
    expect(window).toContain('restart_managed_safe(app.clone()).await')
    expect(window.indexOf('runtime_clear_plugin_quarantine')).toBeLessThan(
      window.indexOf('restore_normal_startup_policy'),
    )
    expect(window.indexOf('restore_normal_startup_policy')).toBeLessThan(
      window.indexOf('restart_managed(app.clone()).await'),
    )
    expect(settings).toContain("'start-safe-mode'")
    expect(settings).toContain("'clear-quarantine'")
  })

  it('gates the installed Windows candidate with real broken-plugin recovery', () => {
    const smoke = read('scripts/smoke-windows-installer.ps1')
    const packaged = read('.github/workflows/windows-packaged-startup.yml')

    expect(smoke).toContain('[switch]$InjectPluginFailure')
    expect(smoke).toContain("harnessdock-smoke-broken-plugin")
    expect(smoke).toContain('plugin-recovery.patch.yml')
    expect(smoke).toContain("(?m)^\\s*disabled:\\s*true\\s*$")
    expect(smoke.match(/function Assert-PluginQuarantineWasExercised/g)).toHaveLength(1)
    expect(smoke).toContain('PASS: broken third-party plugin was quarantined and Harness Web recovered')
    expect(packaged).toContain('-InjectPluginFailure')
  })
})
