import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const readJson = (relative: string) => JSON.parse(read(relative))

describe('HarnessDock Native Host frozen core contract', () => {
  it('uses one exact managed Runtime origin across spawn, validation and ACL', () => {
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const harnessWindow = read('apps/tauri/src-tauri/src/harness_window.rs')
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    expect(runtime).toContain('.args(["--host", "127.0.0.1", "--port", "0", "--no-open"])')
    expect(runtime).toContain('app_url.scheme() != "http"')
    expect(runtime).toContain('Runtime Web URL 必须精确匹配受管 http://127.0.0.1:<port> origin')
    expect(harnessWindow).toContain('url.scheme() != "http"')
    expect(harnessWindow).toContain('url.host_str() != Some("127.0.0.1")')
    expect(harnessWindow).toContain('桌面 Harness WebView 只允许受管的 http://127.0.0.1:<port> Runtime')
    expect(capability.remote.urls).toEqual(['http://127.0.0.1:*/*', 'http://127.0.0.1:*'])
  })

  it('keeps Shell optional but restores native window controls on injection failure', () => {
    const source = read('apps/tauri/src-tauri/src/harness_window.rs')
    expect(source).toContain('restoring native controls')
    expect(source).toContain('window.set_decorations(true)')
    expect(source).toContain('window.set_decorations(false)')
  })

  it('keeps Shell service capabilities aligned with the native bridge', () => {
    const service = read('packages/plugin-harness-shell/src/index.ts')
    const bundle = read('packages/plugin-harness-shell/lib/index.js')
    const bridge = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const remoteCommands = [
      'window.minimize',
      'window.toggleMaximize',
      'window.state',
      'window.close',
      'web.reload',
      'web.restart',
      'runtime.safe-mode',
      'gateway.manage',
      'diagnostics.open',
    ]
    const localOnlyCommands = [
      'runtime.clear-quarantine',
      'app.update.check',
      'app.update.install',
      'app.quit',
    ]
    for (const command of remoteCommands) {
      expect(service).toContain(`'${command}'`)
      expect(bundle).toContain(`"${command}"`)
      expect(bridge).toContain(`'${command}'`)
    }
    for (const command of localOnlyCommands) {
      expect(service).toContain(`'${command}'`)
      expect(bundle).toContain(`"${command}"`)
      expect(bridge).not.toContain(`'${command}'`)
    }
  })

  it('uses explicit recovery/gateway/mobile control-page modes', () => {
    const web = read('apps/tauri/web/app.js')
    const host = read('apps/tauri/src-tauri/src/harness_window.rs')
    expect(web).toContain("let surfaceMode = 'hidden'")
    expect(web).toContain('function setSurfaceMode(mode)')
    expect(web).toContain("setSurfaceMode('recovery')")
    expect(web).toContain("setSurfaceMode('gateway-host')")
    expect(web).toContain("setSurfaceMode('mobile-remote')")
    expect(host).toContain('__harnessDockSetSurface')
  })

  it('keeps Android candidate publication unsigned-compatible by product policy', () => {
    const candidate = read('.github/workflows/tauri-candidate.yml')
    const guard = read('scripts/check-android-package.mjs')
    expect(candidate).not.toContain('ANDROID_KEY_BASE64')
    expect(candidate).not.toContain('ANDROID_KEY_ALIAS')
    expect(candidate).not.toContain('ANDROID_KEY_PASSWORD')
    expect(candidate).not.toContain('configure-android-signing')
    expect(guard).not.toContain('apksigner')
    expect(guard).not.toContain('jarsigner')
    expect(candidate).toContain('Verify Android release package')
  })

  it('keeps active documentation aligned with the exact Runtime ACL', () => {
    const readme = read('README.md')
    const implementation = read('docs/plan/v0.2.0-shell-first-implementation.md')
    expect(readme).toContain('http://127.0.0.1:<port>')
    expect(readme).not.toContain('loopback IPv4、localhost、IPv6 `::1`')
    expect(implementation).toContain('http://127.0.0.1:<port>')
    expect(implementation).toContain('`gateway.manage`')
  })
})
