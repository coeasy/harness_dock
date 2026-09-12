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

describe('older WebView compatibility and explicit safe mode', () => {
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

    // PDF.js 6.x extends Iterator.prototype during import. Prove that such an
    // extension reaches a real built-in iterator, rather than a disconnected
    // compatibility prototype.
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
    expect(lifecycle).toContain('requestAnimationFrame(() => {')
    expect(lifecycle.match(/requestAnimationFrame\(\(\) => \{/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(lifecycle).toContain("const DARK = '#050b14'")
    expect(lifecycle).toContain('__HARNESSDOCK_LIFECYCLE_INSTALLED__')
    expect(lifecycle).not.toContain('setTimeout(')
  })

  it('makes explicit safe mode stronger than an empty DSH_HOME without weakening normal quarantine', () => {
    const safeMode = read('apps/tauri/src-tauri/src/runtime/safe_mode.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')
    const config = read('apps/tauri/src-tauri/src/runtime/config.rs')

    expect(safeMode).toContain('SAFE_MODE_OPTIONAL_OFFICIAL_IDS')
    expect(safeMode).toContain('"ui-sidebar-documentpreview"')
    for (const protectedId of [
      'modules',
      'connection',
      'cordis-client-runner',
      'ui-renderer',
      'ui-session',
      'resources',
      'ui-sidebar-right',
      'embedded-client',
      'harnessdock-client-runtime-compat',
      'harness-shell',
    ]) {
      expect(safeMode).not.toContain(`&["${protectedId}"]`)
      expect(safeMode).not.toContain(`SAFE_MODE_OPTIONAL_OFFICIAL_IDS: &[&str] = &["${protectedId}"]`)
    }

    expect(start).toContain('let safe_patch_file = dir.join("safe-mode.patch.yml")')
    expect(start).toContain('fs::write(&safe_patch_file, safe_mode::patch())')
    expect(start).toContain('&[embedded_patch_file, safe_patch_file.as_path()]')
    expect(start).toContain('process.isolated_plugins = safe_mode::isolated_plugin_ids()')

    // Normal automatic recovery remains conservative: arbitrary official rows
    // are still excluded. The reviewed official deny-list is safe-mode-only.
    expect(config).toContain('&& !is_official_row(row)')
    expect(config).toContain('recovery_never_targets_official_or_embedded_rows')
  })
})
