#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

function read(path) {
  return readFileSync(path, 'utf8')
}

function writeChanged(path, before, after) {
  if (before === after) throw new Error(`${path}: migration produced no change`)
  writeFileSync(path, after)
}

function replaceOnce(text, oldValue, newValue, label) {
  const first = text.indexOf(oldValue)
  if (first < 0) throw new Error(`${label}: anchor not found`)
  if (text.indexOf(oldValue, first + oldValue.length) >= 0) throw new Error(`${label}: anchor is ambiguous`)
  return text.slice(0, first) + newValue + text.slice(first + oldValue.length)
}

function replaceRegexOnce(text, regex, replacement, label) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))]
  if (matches.length !== 1) throw new Error(`${label}: expected 1 match, found ${matches.length}`)
  return text.replace(regex, replacement)
}

// Runtime ready.json and URL contract: exact plain-HTTP 127.0.0.1 origin with explicit port.
{
  const path = 'apps/tauri/src-tauri/src/runtime.rs'
  const before = read(path)
  let after = before
  after = replaceOnce(after,
`    if host != "127.0.0.1" || (app_url.scheme() != "http" && app_url.scheme() != "https") {
        return Err("Runtime Web URL 必须使用受管的 127.0.0.1 HTTP(S) 地址。".into());
    }
    if !app_url.username().is_empty() || app_url.password().is_some() {
        return Err("Runtime Web URL 不能包含用户名或密码。".into());
    }
    let app_port = app_url.port().unwrap_or(if app_url.scheme() == "https" { 443 } else { 80 });`,
`    if host != "127.0.0.1" || app_url.scheme() != "http" {
        return Err("Runtime Web URL 必须使用受管的 http://127.0.0.1:<port> 地址。".into());
    }
    if !app_url.username().is_empty() || app_url.password().is_some() {
        return Err("Runtime Web URL 不能包含用户名或密码。".into());
    }
    let app_port = app_url
        .port()
        .ok_or_else(|| "Runtime Web URL 必须显式包含受管端口。".to_string())?;`,
    'runtime managed URL contract')

  const localhostLine = '        let localhost_alias = r#"{\"url\":\"http://localhost:43123/?token=launch\",\"host\":\"localhost\",\"port\":43123,\"pid\":42,\"dshVersion\":\"0.1.2-alpha.1\"}"#;'
  after = replaceOnce(after, localhostLine,
`${localhostLine}
        let https_alias = r#"{\"url\":\"https://127.0.0.1:43123/?token=launch\",\"host\":\"127.0.0.1\",\"port\":43123,\"pid\":42,\"dshVersion\":\"0.1.2-alpha.1\"}"#;
        let missing_port = r#"{\"url\":\"http://127.0.0.1/?token=launch\",\"host\":\"127.0.0.1\",\"port\":43123,\"pid\":42,\"dshVersion\":\"0.1.2-alpha.1\"}"#;`,
    'runtime strict ready test fixture')
  const localhostAssert = '        assert!(validated_ready(localhost_alias, "0.1.2-alpha.1", 42).is_err());'
  after = replaceOnce(after, localhostAssert,
`${localhostAssert}
        assert!(validated_ready(https_alias, "0.1.2-alpha.1", 42).is_err());
        assert!(validated_ready(missing_port, "0.1.2-alpha.1", 42).is_err());`,
    'runtime strict ready assertions')
  writeChanged(path, before, after)
}

// Harness WebView shares the exact Runtime contract. Optional Shell failure restores native controls.
{
  const path = 'apps/tauri/src-tauri/src/harness_window.rs'
  const before = read(path)
  let after = before
  after = replaceRegexOnce(after,
    /fn validated_runtime_url\(value: &str\) -> Result<Url, String> \{[\s\S]*?\n\}\n\n(?=\/\/\/ dsh 0\.1\.2\+)/,
`fn validated_runtime_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Runtime URL 无效。".to_string())?;
    if url.scheme() != "http" {
        return Err("桌面 Harness WebView 只允许受管的 HTTP Runtime。".into());
    }
    let host = url.host_str().ok_or_else(|| "Runtime URL 缺少主机名。".to_string())?;
    if host != "127.0.0.1" {
        return Err("桌面 Harness WebView 只允许受管的 http://127.0.0.1:<port> Runtime。".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Runtime URL 不能包含用户名或密码。".into());
    }
    let port = url.port().ok_or_else(|| "Runtime URL 必须显式包含受管端口。".to_string())?;
    if port == 0 {
        return Err("Runtime URL 端口无效。".into());
    }
    Ok(url)
}

`, 'Harness managed URL validator')

  after = replaceOnce(after,
`    if let Err(error) = window.eval(init_script()) {
        // The Harness document remains the primary surface even if a best-
        // effort toolbar injection is rejected by a WebView implementation.
        // Menu and native commands remain available for a later retry.
        eprintln!("Unable to install Harness Shell; continuing with Harness Web: {error}");
    }`,
`    match window.eval(init_script()) {
        Ok(()) => {
            let _ = window.set_decorations(false);
        }
        Err(error) => {
            // The Shell is optional. Restore the native titlebar so a failed
            // injection can never strand a borderless primary window.
            eprintln!("Unable to install Harness Shell; restoring native window controls: {error}");
            let _ = window.set_decorations(true);
        }
    }`, 'Shell native-titlebar fail-open')

  after = replaceRegexOnce(after,
    /(?<indent>\s*)let control = app\n\s*\.get_webview_window\("main"\)\n\s*\.ok_or_else\(\|\| "HarnessDock 控制页窗口不存在。"\.to_string\(\)\)\?;\n\s*control\n\s*\.show\(\)/,
`        let control = app
            .get_webview_window("main")
            .ok_or_else(|| "HarnessDock 控制页窗口不存在。".to_string())?;
        let surface = app
            .state::<crate::AppState>()
            .startup_recovery_error
            .lock()
            .map(|recovery| if recovery.is_some() { "recovery" } else { "gateway-host" })
            .unwrap_or("recovery");
        if let Ok(value) = serde_json::to_string(surface) {
            let _ = control.eval(format!("window.__harnessDockSetSurface?.({value})"));
        }
        control
            .show()`, 'control_show explicit surface mode')
  writeChanged(path, before, after)
}

// Independent shell service metadata must match the bridge, including Gateway management.
{
  const path = 'packages/plugin-harness-shell/src/index.ts'
  const before = read(path)
  const after = replaceOnce(before,
`    'runtime.clear-quarantine',
    'diagnostics.open',`,
`    'runtime.clear-quarantine',
    'gateway.manage',
    'diagnostics.open',`, 'shell service gateway capability')
  writeChanged(path, before, after)
}

// Explicit control-page state instead of distributed hidden-class inference.
{
  const path = 'apps/tauri/web/app.js'
  const before = read(path)
  let after = before
  after = replaceOnce(after,
`  let currentRuntime
  let desktopStartup

  function showRecoveryCards() {`,
`  let currentRuntime
  let desktopStartup
  let surfaceMode = 'hidden'

  function setSurfaceMode(mode) {
    surfaceMode = mode
    const visibility = {
      recovery: ['desktop-card'],
      'gateway-host': ['gateway-host-card'],
      'mobile-remote': ['mobile-remote-card'],
      hidden: [],
    }
    const visible = new Set(visibility[mode] || [])
    for (const id of ['desktop-card', 'gateway-host-card', 'mobile-remote-card']) {
      $(id)?.classList.toggle('hidden', !visible.has(id))
    }
  }

  window.__harnessDockSetSurface = (mode) => {
    if (!['recovery', 'gateway-host', 'mobile-remote', 'hidden'].includes(mode)) return
    setSurfaceMode(mode)
    if (mode === 'gateway-host') void refreshVisibleControl()
  }

  function showRecoveryCards() {`, 'control surface state')
  after = replaceOnce(after,
`    $('desktop-card')?.classList.remove('hidden')
    $('gateway-host-card')?.classList.add('hidden')`,
`    setSurfaceMode('recovery')`, 'recovery surface')
  after = replaceOnce(after, `        $('gateway-host-card')?.classList.remove('hidden')`, `        setSurfaceMode('gateway-host')`, 'desktop gateway surface')
  after = replaceOnce(after, `        $('mobile-remote-card').classList.remove('hidden')`, `        setSurfaceMode('mobile-remote')`, 'mobile remote surface')
  writeChanged(path, before, after)
}

// Active docs must describe the current strict ACL and complete Shell command contract.
{
  const path = 'README.md'
  const before = read(path)
  const after = replaceOnce(before,
'- loopback IPv4、localhost、IPv6 `::1` 根路径和子路径统一纳入外壳 ACL，避免 Harness Web 首屏或菜单调用出现 `Command ... not allowed by ACL`。',
'- 桌面 Harness Shell 权限只授予受管的 `http://127.0.0.1:<ephemeral-port>` Runtime origin；localhost、IPv6、HTTPS alias 与其它本机服务均不获得外壳 IPC。', 'README ACL statement')
  writeChanged(path, before, after)
}
{
  const path = 'docs/plan/v0.2.0-shell-first-implementation.md'
  const before = read(path)
  let after = replaceOnce(before,
'| `runtime.clear-quarantine` | 支持 |\n| `diagnostics.open` | 支持 |',
'| `runtime.clear-quarantine` | 支持 |\n| `gateway.manage` | 支持 |\n| `diagnostics.open` | 支持 |', 'implementation command table')
  after = replaceOnce(after,
'远程 Harness/Gateway 页面不获得本地 Tauri capability；只有校验过的 loopback Harness WebView 才获得 `harness-shell` capability。',
'远程 Harness/Gateway 页面不获得本地 Tauri capability；只有与当前受管 `http://127.0.0.1:<port>` Runtime origin 完全一致的 Harness WebView 才获得 `harness-shell` capability。', 'implementation ACL statement')
  writeChanged(path, before, after)
}

// Update stale parity expectations without weakening them.
{
  const path = 'tests/parity/tauri-host.test.ts'
  const before = read(path)
  let after = replaceOnce(before,
`    expect(harnessWindow).toContain('127.0.0.1/localhost Runtime')`,
`    expect(harnessWindow).toContain('http://127.0.0.1:<port> Runtime')
    expect(harnessWindow).toContain('window.set_decorations(true)')
    expect(harnessWindow).toContain('window.set_decorations(false)')
    expect(runtime).toContain('app_url.scheme() != "http"')`, 'tauri-host Runtime origin assertion')
  const shellAssetLine = `    const shellAsset = readFileSync(path.join(repoRoot, 'packages/plugin-harness-shell/src/web/shell.js'), 'utf8')`
  after = replaceOnce(after, shellAssetLine, `${shellAssetLine}\n    const shellService = readFileSync(path.join(repoRoot, 'packages/plugin-harness-shell/src/index.ts'), 'utf8')`, 'tauri-host shell service read')
  const gatewayBridgeAssert = `    expect(shell).toContain("'gateway.manage': 'control_show'")`
  after = replaceOnce(after, gatewayBridgeAssert, `${gatewayBridgeAssert}\n    expect(shellService).toContain("'gateway.manage'")`, 'tauri-host gateway capability assertion')
  after = replaceOnce(after,
`    expect(web).toContain("gateway-host-card')?.classList.remove('hidden')")
    expect(web).toContain("gateway-host-card')?.classList.add('hidden')")`,
`    expect(web).toContain('function setSurfaceMode(mode)')
    expect(web).toContain("setSurfaceMode('gateway-host')")
    expect(web).toContain("setSurfaceMode('mobile-remote')")
    expect(harnessWindow).toContain('__harnessDockSetSurface')`, 'tauri-host control surface assertions')
  writeChanged(path, before, after)
}
{
  const path = 'tests/parity/tauri-shell-fail-open.test.ts'
  const before = read(path)
  const anchor = `  it('uses the packaged Node by default and requires an explicit system-Node opt-in', () => {`
  const block = `  it('falls back to native window controls when the optional shell cannot be installed', () => {
    const harnessWindow = read('apps/tauri/src-tauri/src/harness_window.rs')
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const shellService = read('packages/plugin-harness-shell/src/index.ts')
    const shellBundle = read('packages/plugin-harness-shell/lib/index.js')
    expect(harnessWindow).toContain('window.set_decorations(true)')
    expect(harnessWindow).toContain('window.set_decorations(false)')
    expect(harnessWindow).toContain('http://127.0.0.1:<port> Runtime')
    expect(runtime).toContain('app_url.scheme() != "http"')
    expect(shellService).toContain("'gateway.manage'")
    expect(shellBundle).toContain('"gateway.manage"')
  })

`
  const after = replaceOnce(before, anchor, block + anchor, 'fail-open native-control test')
  writeChanged(path, before, after)
}

writeFileSync('tests/parity/v020-core-contract.test.ts', `import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')
const readJson = (relative: string) => JSON.parse(read(relative))

describe('HarnessDock v0.2.0 frozen core contract', () => {
  it('uses one exact managed Runtime origin across spawn, validation and ACL', () => {
    const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
    const harnessWindow = read('apps/tauri/src-tauri/src/harness_window.rs')
    const capability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
    expect(runtime).toContain('.args(["--host", "127.0.0.1", "--port", "0", "--no-open"])')
    expect(runtime).toContain('app_url.scheme() != "http"')
    expect(runtime).toContain('Runtime Web URL 必须显式包含受管端口')
    expect(harnessWindow).toContain('url.scheme() != "http"')
    expect(harnessWindow).toContain('host != "127.0.0.1"')
    expect(harnessWindow).toContain('Runtime URL 必须显式包含受管端口')
    expect(capability.remote.urls).toEqual(['http://127.0.0.1:*/*', 'http://127.0.0.1:*'])
  })

  it('keeps Shell optional but restores native window controls on injection failure', () => {
    const source = read('apps/tauri/src-tauri/src/harness_window.rs')
    expect(source).toContain('restoring native window controls')
    expect(source).toContain('window.set_decorations(true)')
    expect(source).toContain('window.set_decorations(false)')
  })

  it('keeps Shell service capabilities aligned with the native bridge', () => {
    const service = read('packages/plugin-harness-shell/src/index.ts')
    const bundle = read('packages/plugin-harness-shell/lib/index.js')
    const bridge = read('apps/tauri/src-tauri/src/harness_shell.rs')
    for (const command of ['window.minimize', 'window.toggleMaximize', 'window.state', 'window.close', 'web.reload', 'web.restart', 'runtime.safe-mode', 'runtime.clear-quarantine', 'gateway.manage', 'diagnostics.open', 'app.update.check', 'app.update.install', 'app.quit']) {
      expect(service).toContain(\`'\${command}'\`)
      expect(bundle).toContain(\`"\${command}"\`)
      expect(bridge).toContain(\`'\${command}'\`)
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
    expect(readme).toContain('http://127.0.0.1:<ephemeral-port>')
    expect(readme).not.toContain('loopback IPv4、localhost、IPv6 \\`::1\\`')
    expect(implementation).toContain('http://127.0.0.1:<port>')
    expect(implementation).toContain('\\`gateway.manage\\`')
  })
})
`)

console.log('v0.2.0 core hardening migration applied successfully')
