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

    expect(lifecycle).toContain("status.textContent = '正在载入 Harness Web…'")
    expect(lifecycle).toContain("node.dataset.mode = 'startup'")
    expect(lifecycle).toContain('new MutationObserver(settleStartupPaint)')
    expect(lifecycle).toContain("child.id === 'dsh-harness-shell'")
    expect(lifecycle).toContain("child.id === 'harnessdock-lifecycle-surface'")
    expect(lifecycle.match(/requestAnimationFrame\(\(\) => \{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(lifecycle).toContain("const DARK = '#07101d'")
    expect(lifecycle).toContain('__HARNESSDOCK_LIFECYCLE_INSTALLED__')
    expect(lifecycle).not.toContain('setTimeout(')
  })

  it('starts the normal web profile while isolating every external plugin generation-locally', () => {
    const safeMode = read('apps/tauri/src-tauri/src/runtime/safe_mode.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')
    const config = read('apps/tauri/src-tauri/src/runtime/config.rs')
    const launch = read('apps/tauri/src-tauri/src/runtime/launch_settings.rs')

    expect(safeMode).toContain('recovery_candidates(rows)')
    expect(safeMode).toContain('recovery_plan(rows, diagnostic).1')
    expect(safeMode).toContain('pub struct RescuePlan')
    expect(start).toContain('profile: DEFAULT_PROFILE.into()')
    expect(start).toContain('dsh_home: launch.dsh_home.clone()')
    expect(start).toContain('let rescue = safe_mode::plan(&rows, diagnostic)')
    expect(start).toContain('let rescue_patch_file = dir.join("rescue-web.patch.yml")')
    expect(start).toContain('process.recovery_source = "rescue-web".into()')
    expect(start).toContain('process.isolated_plugins = isolated_plugins')
    expect(start).toContain('process.suspected_plugins = suspected_plugins')
    expect(start).toContain('"rescue-web-private-home"')
    expect(launch).toContain('Start the shipped Web application while isolating all external/user')

    // Automatic quarantine remains conservative: normal mode still never
    // disables arbitrary official rows. Rescue Web reuses that external-row
    // classifier, rather than maintaining a fragile official allow/deny list.
    expect(config).toContain('&& !is_official_row(row)')
    expect(config).toContain('recovery_never_targets_official_or_embedded_rows')
    expect(safeMode).not.toContain('SAFE_MODE_OPTIONAL_OFFICIAL_IDS')
    expect(safeMode).not.toContain('ui-sidebar-documentpreview')
  })

  it('makes Rescue Web diagnosis and restore actions visible to the user', () => {
    const html = read('apps/tauri/web/settings.html')
    const js = read('apps/tauri/web/settings.js')

    expect(html).toContain('救援模式（隔离第三方插件）')
    expect(html).toContain('恢复全部插件并正常重启')
    expect(html).toContain('id="suspected-plugin-list"')
    expect(html).toContain('id="isolated-plugin-list"')
    expect(js).toContain("call('public_runtime_status')")
    expect(js).toContain("'start-safe-mode'")
    expect(js).toContain("'clear-quarantine'")
    expect(js).toContain('runtimeStatus?.isolatedPlugins')
    expect(js).toContain('runtimeStatus?.suspectedPlugins')
  })
})
