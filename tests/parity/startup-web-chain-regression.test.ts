import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

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
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const control = read('apps/tauri/web/app.js')

    expect(config).toMatch(/"label": "splash"[\s\S]*?"visible": false/)
    expect(startup).toContain('harness_window::hide_splash(&app)')
    expect(startup).not.toContain('正在验证内置 Harness Runtime')
    expect(startup).not.toContain('正在打开 Harness Web')
    expect(window).toContain('harness_open_impl(app, url, false).await')

    // The candidate already verifies the sealed Runtime image. Normal launch
    // resolves the packaged paths and spawns directly instead of doing a second
    // node.exe/bin.js existence preflight in the user startup path.
    expect(runtime).toContain('fn load_runtime_image(')
    expect(runtime).not.toContain('fn verify_runtime_image(')
    expect(runtime).not.toContain('!node.is_file()')
    expect(runtime).not.toContain('!dsh.is_file()')
    expect(control).not.toContain('Node=${current.nodeSource}')
    expect(control).not.toContain('运行环境检测失败')
  })

  it('does not revoke the published RuntimeLease from WebView or host-surface callbacks', () => {
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window.rs')
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')

    expect(window).toContain('crate::runtime::current_lease(&*app.state::<crate::AppState>())')
    expect(window).not.toContain('crate::runtime::live_lease(&*app.state::<crate::AppState>())')
    expect(startup).toContain('crate::runtime::current_lease(&*app.state::<AppState>())')
    expect(startup).not.toContain('crate::runtime::live_lease(&*app.state::<AppState>())')
    expect(reconciler).toContain('crate::runtime::current_lease(&*state)')
    expect(reconciler).toContain('crate::runtime::current_lease(&*app.state::<crate::AppState>())')
    expect(reconciler).not.toContain('crate::runtime::live_lease(')

    // A liveness inspection error is unknown state, not confirmed process exit.
    expect(runtime).toContain('preserving current RuntimeLease')
    expect(runtime).toMatch(/Err\(error\)\s*=>\s*\{[\s\S]*?preserving current RuntimeLease[\s\S]*?true/)
    expect(runtime).not.toContain('Ok(status_snapshot(&*state))')
  })

  it('ignores stale or transitional WebView callbacks instead of opening recovery', () => {
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window.rs')

    expect(window).toContain('if !current_matches_event')
    expect(window).toContain('Ignoring Harness page-load callback while RuntimeLease is transitioning')
    expect(window).not.toContain('Harness Web 加载完成时 RuntimeLease 已失效。')
    expect(startup).toContain('let Some(lease) = crate::runtime::current_lease')
    expect(startup).toContain('stable_clean_polls = 0;')
    expect(startup).not.toContain('Harness WebView 已创建，但当前 RuntimeLease 已失效。')
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
