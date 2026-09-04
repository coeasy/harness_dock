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
})
