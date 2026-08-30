#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const json = (p) => JSON.parse(read(p))
const fail = (message) => { console.error(`tauri host contract failed: ${message}`); process.exitCode = 1 }
const assert = (condition, message) => { if (!condition) fail(message) }

const pkg = json('package.json')
const origin = json('packages/docs-sync/origin.json')
const tauriOrigin = json('apps/tauri/src-tauri/resources/origin.json')
const config = json('apps/tauri/src-tauri/tauri.conf.json')
const android = json('apps/tauri/src-tauri/tauri.android.conf.json')
const ios = json('apps/tauri/src-tauri/tauri.ios.conf.json')
const cargo = read('apps/tauri/src-tauri/Cargo.toml')
const rust = read('apps/tauri/src-tauri/src/lib.rs')
const frontend = read('apps/tauri/src/app.js')
const gateway = read('apps/tauri/src-tauri/resources/gateway-host.mjs')

for (const file of [
  'apps/tauri/src/index.html',
  'apps/tauri/src/styles.css',
  'apps/tauri/src/app.js',
  'apps/tauri/src-tauri/src/lib.rs',
  'apps/tauri/src-tauri/src/main.rs',
  'apps/tauri/src-tauri/resources/gateway-host.mjs',
  'apps/tauri/src-tauri/capabilities/default.json',
]) assert(existsSync(path.join(root, file)), `missing ${file}`)

assert(pkg.version === '0.2.0', `root version must remain 0.2.0, got ${pkg.version}`)
assert(config.version === pkg.version, `tauri.conf version ${config.version} != root ${pkg.version}`)
assert(origin.clientVersion === pkg.version, `origin clientVersion ${origin.clientVersion} != root ${pkg.version}`)
assert(tauriOrigin.clientVersion === pkg.version, `Tauri origin clientVersion ${tauriOrigin.clientVersion} != root ${pkg.version}`)
assert(tauriOrigin.dshVersion === origin.dshVersion, 'Tauri dsh pin must match canonical origin.json')
assert(tauriOrigin.gitCommit === origin.gitCommit, 'Tauri upstream commit pin must match canonical origin.json')
assert(new RegExp(`version\\s*=\\s*"${pkg.version.replaceAll('.', '\\.') }"`).test(cargo), 'Cargo package version must match root')
assert(/tauri\s*=\s*\{\s*version\s*=\s*"2"/.test(cargo), 'Cargo must use Tauri 2')
assert(config.identifier === 'com.harnessdock.client', `unexpected bundle identifier ${config.identifier}`)
assert(config.build?.frontendDist === '../src', 'Tauri must use the shared static launcher frontend')

const desktopResources = config.bundle?.resources || {}
assert(Object.keys(desktopResources).some((key) => key.includes('dsh-runtime')), 'desktop Tauri bundle must include canonical dsh runtime')
assert(Object.keys(desktopResources).some((key) => key.includes('gateway-host.mjs')), 'desktop Tauri bundle must include Gateway host')
assert(Object.keys(desktopResources).some((key) => key.includes('plugin-embedded-client')), 'desktop Tauri bundle must include embedded-client plugin')
for (const [name, mobile] of [['Android', android], ['iOS', ios]]) {
  assert(Array.isArray(mobile.bundle?.resources), `${name} config must replace desktop resources with a mobile-only array`)
  assert(mobile.bundle.resources.length === 1 && mobile.bundle.resources[0] === 'resources/origin.json', `${name} must not bundle local dsh/Node runtime`)
}

for (const command of ['start_local_runtime', 'stop_local_runtime', 'start_gateway', 'gateway_create_pairing', 'gateway_devices', 'gateway_revoke_device', 'pair_remote']) {
  assert(rust.includes(command), `Rust host missing command ${command}`)
}
assert(rust.includes('cfg!(any(target_os = "android", target_os = "ios"))'), 'Rust host must explicitly detect mobile target')
assert(frontend.includes("call('pair_remote'"), 'launcher must implement remote pairing')
assert(frontend.includes('endpointUrl'), 'launcher must pass camelCase endpointUrl to Tauri')
assert(gateway.includes('primeUpstreamAuthentication'), 'Gateway must preserve upstream dsh launch-token authentication')
assert(gateway.includes("publicServer.on('upgrade'"), 'Gateway must proxy WebSocket upgrades')
assert(gateway.includes('HttpOnly; Path=/; SameSite=Strict'), 'Gateway session cookie must be HttpOnly + SameSite=Strict')
assert(gateway.includes('timingSafeEqual'), 'Gateway admin token comparison must be timing-safe')

if (!process.exitCode) console.log(`tauri host contract ok: HarnessDock ${pkg.version}, dsh ${origin.dshVersion}, desktop local + Android/iOS remote`)
