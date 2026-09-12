import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

function rawRustScript(source: string, constant: string): string {
  const marker = `const ${constant}: &str = r#"\n`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`${constant} raw script not found`)
  const bodyStart = start + marker.length
  const end = source.indexOf('\n"#;', bodyStart)
  if (end < 0) throw new Error(`${constant} raw script terminator not found`)
  return source.slice(bodyStart, end)
}

describe('older WebView compatibility and Rescue Web mode', () => {
  it('installs a shared Iterator compatibility global before PDF.js loader entries run', () => {
    const shellHost = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const polyfill = rawRustScript(shellHost, 'POLYFILL_SCRIPT')
    const context = vm.createContext({ AbortController, AbortSignal })

    vm.runInContext('globalThis.Iterator = undefined', context)
    vm.runInContext(polyfill, context)

    expect(vm.runInContext('typeof Iterator', context)).toBe('function')
    expect(
      vm.runInContext(
        'Iterator.prototype === Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))',
        context,
      ),
    ).toBe(true)
    vm.runInContext(
      "Iterator.prototype.__harnessDockProbe = function () { return this.next().value }",
      context,
    )
    expect(vm.runInContext('[41][Symbol.iterator]().__harnessDockProbe()', context)).toBe(41)

    expect(shellHost.indexOf('POLYFILL_SCRIPT')).toBeLessThan(
      shellHost.indexOf('LIFECYCLE_SCRIPT'),
    )
    expect(shellHost).toContain("typeof globalThis.Iterator === 'undefined'")
    expect(shellHost).toContain("Object.defineProperty(globalThis, 'Iterator'")
  })

  it('keeps the primary first paint covered until actual Harness content is painted', () => {
    const shellHost = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const lifecycle = rawRustScript(shellHost, 'LIFECYCLE_SCRIPT')

    expect(() => new vm.Script(lifecycle)).not.toThrow()
    expect(lifecycle).toContain("status.textContent = '正在载入 Harness Web…'")
    expect(lifecycle).toContain("node.dataset.mode = 'startup'")
    expect(lifecycle).toContain('new MutationObserver(observeStartup)')
    expect(lifecycle).toContain("child.id === 'dsh-harness-shell'")
    expect(lifecycle).toContain("child.id === 'harnessdock-lifecycle-surface'")
    expect(lifecycle.match(/requestAnimationFrame\(\(\) => \{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(lifecycle).toContain("const DARK = '#07101d'")
    expect(lifecycle).toContain('__HARNESSDOCK_LIFECYCLE_INSTALLED__')
    expect(lifecycle).not.toContain('setTimeout(')
  })

  it('runs every Rescue Web generation in a private DSH_HOME and never reuses the failing profile writer lock', () => {
    const safeMode = read('apps/tauri/src-tauri/src/runtime/safe_mode.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')
    const config = read('apps/tauri/src-tauri/src/runtime/config.rs')
    const launch = read('apps/tauri/src-tauri/src/runtime/launch_settings.rs')

    expect(safeMode).toContain('let isolated_rows = rescue_candidates(rows)')
    expect(safeMode).toContain('!is_official_source(&row.source)')
    expect(safeMode).toContain('HARNESSDOCK_INTEGRATION_IDS')
    expect(safeMode).toContain('rescue_suspects(&isolated_rows, diagnostic)')
    expect(safeMode).toContain('pub struct RescuePlan')
    expect(safeMode).toContain('rescue_uses_source_provenance_not_a_spoofable_declared_name')

    expect(start).toContain('let rows = user_patch_rows(DEFAULT_PROFILE, launch.dsh_home.as_deref())')
    expect(start).toContain('let safe_home = dir.join("rescue-dsh-home")')
    expect(start).toContain('Some(&safe_home)')
    expect(start).toContain('"rescue-private-home"')
    expect(start).toContain('"rescue-web-private-home"')
    expect(start).toContain('"profile-lock-private-home"')
    expect(start).toContain('profile_writer_lock_failure')
    expect(start).toContain('diagnostic.contains("node_modules.lock")')
    expect(start).toContain('switching directly to private Rescue Web')
    expect(start).not.toContain('dsh_home: launch.dsh_home.clone()')
    expect(start).not.toContain('rescue_launch.dsh_home.as_deref()')
    expect(start).not.toContain('let rescue_patch_file = dir.join("rescue-web.patch.yml")')

    // Normal starts still honour the configured/user DSH_HOME. Only Rescue is
    // isolated, preserving normal profile semantics without inheriting its lock.
    expect(start).toContain('launch.dsh_home.as_deref()')
    expect(launch).toContain('generation-private DSH_HOME')
    expect(launch).toContain('writer locks cannot block the fallback Web')

    expect(config).toContain('&& !is_official_row(row)')
    expect(config).toContain('recovery_never_targets_official_or_embedded_rows')
    expect(safeMode).not.toContain('SAFE_MODE_OPTIONAL_OFFICIAL_IDS')
    expect(safeMode).toContain('assert!(!patch.contains("ui-sidebar-documentpreview"))')
  })

  it('routes sanitized Loader plugin attribution through Host Protocol v2', () => {
    const shellHost = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const lifecycle = rawRustScript(shellHost, 'LIFECYCLE_SCRIPT')
    const bridge = read('apps/tauri/src-tauri/src/bridge.rs')
    const protocol = read('apps/tauri/src-tauri/src/host_protocol.rs')
    const generated = read('apps/tauri/src-tauri/src/host_protocol_generated.rs')
    const broker = read('apps/tauri/src-tauri/src/capability_broker.rs')
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')
    const state = read('apps/tauri/src-tauri/src/state.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window/window.rs')
    const permissions = read('apps/tauri/src-tauri/permissions/harnessdock.toml')
    const harnessCapability = read('apps/tauri/src-tauri/capabilities/harness-shell.json')
    const diagnosticsCapability = read('apps/tauri/src-tauri/capabilities/shell-settings.json')
    const schema = read('protocol/host-protocol-v2.json')

    expect(lifecycle).toContain('failed to import loader entry')
    expect(lifecycle).toContain("invoke('host_execute', { envelope })")
    expect(lifecycle).toContain("subject: 'harness-web'")
    expect(lifecycle).toContain("type: 'report-client-plugin-failure'")
    expect(lifecycle).toContain("window.addEventListener('error'")
    expect(lifecycle).toContain("window.addEventListener('unhandledrejection'")
    expect(lifecycle).toContain('reportedLoaderPlugins = new Set()')
    expect(protocol).toContain('valid_client_plugin_identifier')
    expect(protocol).toContain('CLIENT_PLUGIN_ID_INVALID')
    expect(generated).toContain('ReportClientPluginFailure { plugin: String }')
    expect(generated).toContain('Capability::ClientDiagnosticReport')
    expect(broker).toContain('Capability::ClientDiagnosticReport => Decision::Allow')
    expect(broker).toContain('client-diagnostic-report-requires-harness-web')
    expect(reconciler).toContain('const MAX_CLIENT_PLUGIN_FAILURES: usize = 32')
    expect(reconciler).toContain('record_client_plugin_failure')
    expect(reconciler).toContain('state.client_plugin_failures.lock()')
    expect(bridge).toContain('status.suspected_plugins.push(plugin)')
    expect(bridge).not.toContain('pub fn report_client_plugin_failure')
    expect(state).toContain('client_plugin_failures: Mutex<Vec<String>>')
    expect(window).toContain('client_plugin_failures.lock()')
    expect(permissions).not.toContain('identifier = "client-plugin-diagnostics"')
    expect(permissions).not.toContain('commands.allow = ["report_client_plugin_failure"]')
    expect(harnessCapability).not.toContain('"client-plugin-diagnostics"')
    expect(harnessCapability).toContain('"host-protocol"')
    expect(schema).toContain('"report-client-plugin-failure"')
    expect(schema).toContain('"ClientDiagnosticReport"')
    expect(diagnosticsCapability).toContain('"runtime-status"')
    expect(diagnosticsCapability).not.toContain('"runtime-maintenance"')
  })

  it('makes Rescue Web diagnosis and restore actions visible to the user', () => {
    const html = read('apps/tauri/web/settings.html')
    const js = read('apps/tauri/web/settings.js')
    const launch = read('apps/tauri/src-tauri/src/runtime/launch_settings.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window/window.rs')

    expect(html).toContain('救援模式（隔离第三方插件）')
    expect(html).toContain('恢复全部插件并正常重启')
    expect(html).toContain('id="suspected-plugin-list"')
    expect(html).toContain('id="isolated-plugin-list"')
    expect(js).toContain("call('public_runtime_status')")
    expect(js).toContain("'start-safe-mode'")
    expect(js).toContain("'clear-quarantine'")
    expect(js).toContain('runtimeStatus?.isolatedPlugins')
    expect(js).toContain('runtimeStatus?.suspectedPlugins')

    expect(launch).toContain('pub fn restore_normal_startup_policy')
    expect(launch).toContain('settings.startup_policy = RuntimeStartupPolicy::Auto')
    expect(window).toContain('crate::runtime::restore_normal_startup_policy(&app)')
    expect(window.indexOf('runtime_clear_plugin_quarantine')).toBeLessThan(
      window.indexOf('restore_normal_startup_policy'),
    )
    expect(window.indexOf('restore_normal_startup_policy')).toBeLessThan(
      window.indexOf('restart_managed(app.clone()).await'),
    )
  })
})
