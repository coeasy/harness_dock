import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

function rustFiles(relative: string): string[] {
  const absolute = path.join(repoRoot, relative)
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) return rustFiles(child)
    return entry.isFile() && entry.name.endsWith('.rs') ? [child] : []
  })
}

describe('packaged startup Web chain regression', () => {
  it('keeps the splash compatible with its strict CSP', () => {
    const html = read('apps/tauri/web/splash.html')
    const css = read('apps/tauri/web/splash.css')
    const script = read('apps/tauri/web/splash.js')

    expect(html).toContain("script-src 'self'; style-src 'self'")
    expect(html).toContain('<link rel="stylesheet" href="./splash.css" />')
    expect(html).toContain('<script src="./splash.js" defer></script>')
    expect(html).not.toMatch(/<style(?:\s|>)/i)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(css).toContain('.splash')
    expect(css).toContain('.spinner')
    expect(css).toContain('.progress::before')
    expect(script).toContain('window.__harnessDockSetStatus')
  })

  it('keeps the normal packaged launch on the primary Harness Web surface', () => {
    const config = read('apps/tauri/src-tauri/tauri.conf.json')
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window.rs')

    expect(config).toMatch(/"label": "splash"[\s\S]*?"visible": false/)
    expect(startup).toContain('harness_window::hide_splash(&app)')
    expect(startup).not.toContain('正在验证内置 Harness Runtime')
    expect(startup).not.toContain('正在打开 Harness Web')
    expect(window).toContain('harness_open_impl(app, url, false).await')
  })

  it('does not revoke the published RuntimeLease from a WebView load callback', () => {
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window.rs')

    expect(window).toContain('crate::runtime::current_lease(&*app.state::<crate::AppState>())')
    expect(window).not.toContain('crate::runtime::live_lease(&*app.state::<crate::AppState>())')
    expect(startup).toContain('crate::runtime::current_lease(&*app.state::<AppState>())')
    expect(startup).not.toContain('crate::runtime::live_lease(&*app.state::<AppState>())')
  })

  it('keeps Host Protocol and local authorization lease reads observational', () => {
    const bridge = read('apps/tauri/src-tauri/src/bridge.rs')
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')

    expect(bridge).toContain('crate::runtime::current_lease')
    expect(bridge).not.toContain('crate::runtime::live_lease')
    expect(reconciler).toContain('subject == SubjectKind::HarnessWeb')
    expect(reconciler).toContain('crate::runtime::current_lease')
    expect(reconciler).not.toContain('crate::runtime::live_lease')
    expect(reconciler).toContain('Native/menu/tray/diagnostics authorization does not depend on Runtime')
  })

  it('forbids side-effecting live_lease reads outside explicit Runtime/Gateway lifecycle boundaries', () => {
    const lifecycleFiles = new Set([
      'apps/tauri/src-tauri/src/runtime.rs',
      'apps/tauri/src-tauri/src/gateway_host.rs',
    ])
    const offenders = rustFiles('apps/tauri/src-tauri/src').filter(
      (file) => !lifecycleFiles.has(file) && read(file).includes('runtime::live_lease'),
    )
    expect(offenders).toEqual([])

    const gateway = read('apps/tauri/src-tauri/src/gateway_host.rs')
    expect(gateway.match(/runtime::live_lease/g)?.length).toBe(2)
    expect(gateway).toContain('fn runtime_lease(state: &AppState)')
    expect(gateway).toContain('fn ensure_current_runtime(state: &AppState, generation: u64)')
    expect(gateway).toContain('unexpected Runtime exit before any pairing/proxy operation uses it')
  })

  it('does not revoke a healthy lease when process inspection is inconclusive', () => {
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const alive = runtime.slice(
      runtime.indexOf('pub(crate) fn is_alive'),
      runtime.indexOf('pub(crate) fn stop', runtime.indexOf('pub(crate) fn is_alive')),
    )

    expect(alive).toContain('Ok(Some(_))')
    expect(alive).toContain('false')
    expect(alive).toContain('Ok(None) => true')
    expect(alive).toContain('preserving current RuntimeLease until exit is confirmed')
    expect(alive).toMatch(/Err\(error\)[\s\S]*?true/)
  })

  it('reveals a clean authenticated Runtime URL even when WebView redirect events reorder', () => {
    const startup = read('apps/tauri/src-tauri/src/startup.rs')

    expect(startup).toContain('reveal_clean_runtime_fallback')
    expect(startup).toContain('current.origin().ascii_serialization() == lease.origin')
    expect(startup).toContain('key == "token" && !value.is_empty()')
    expect(startup).toContain('stable_clean_polls >= 5')
    expect(startup).toContain('actor.finish_navigation(navigation_id, lease.generation.id)')
    expect(startup).toContain('window.set_decorations(true)')
    expect(startup).toMatch(/window\s*\.show\(\)/)
    expect(startup).toContain('harness_window::hide_splash(app)')
    expect(startup.indexOf('open_for_startup')).toBeLessThan(
      startup.lastIndexOf('reveal_clean_runtime_fallback(&app).await'),
    )
  })

  it('smokes the same embedded, compatibility and Harness Shell plugin composition as production', () => {
    const smoke = read('packages/client-runtime/src/smoke-cli.ts')
    const candidate = read('.github/workflows/tauri-candidate.yml')

    expect(smoke).toContain("'plugin-harness-shell', 'lib', 'index.js'")
    expect(smoke).toContain('shellPluginPath,')
    expect(candidate).toContain('Build embedded client')
    expect(candidate).toContain('Build independent Harness Shell plugin')
    expect(candidate).toContain('@dsh/client-runtime smoke-runtime')
  })

  it('launches the actual Cargo binary from the installed Windows candidate', () => {
    const cargo = read('apps/tauri/src-tauri/Cargo.toml')
    const packagedSmoke = read('.github/workflows/windows-packaged-startup.yml')

    expect(cargo).toContain('name = "harnessdock-tauri"')
    expect(packagedSmoke).toContain("-Filter 'harnessdock-tauri.exe'")
    expect(packagedSmoke).not.toContain("-Filter 'HarnessDock.exe'")
    expect(packagedSmoke).toContain('Installed harnessdock-tauri.exe not found')
  })

  it('keeps skipped duplicate startup smokes from masquerading as package failures', () => {
    const release = read('.github/workflows/release.yml')

    expect(release).toContain('startup_deadline=$((SECONDS + 900))')
    expect(release).toContain('.conclusion == "failure" or .conclusion == "timed_out"')
    expect(release).toContain('.conclusion == "action_required" or .conclusion == "startup_failure"')
    expect(release).not.toContain('.conclusion != "success"')
  })
})
