import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeCandidateMatrix, desktopCandidateMatrix } from './release/candidate-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
import { rustSource } from './lib/rust-source.mjs'
const read = (relative) =>
  relative.endsWith('.rs') ? rustSource(root, relative) : readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
const candidate = read('.github/workflows/tauri-candidate.yml')
const tauriPackage = readJson('apps/tauri/package.json')
const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
const runtimeActor = read('apps/tauri/src-tauri/src/runtime_actor.rs')
const state = read('apps/tauri/src-tauri/src/state.rs')
const processControl = read('apps/tauri/src-tauri/src/process.rs')
const gatewayHost = read('apps/tauri/src-tauri/src/gateway_host.rs')
const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
const platform = read('apps/tauri/src-tauri/src/platform.rs')
const bridge = read('apps/tauri/src-tauri/src/bridge.rs')
const embeddedReadyProducer = read('packages/plugin-embedded-client/src/index.ts')
const shellCapability = readJson('apps/tauri/src-tauri/capabilities/harness-shell.json')
const runtimePackage = readJson('packages/client-runtime/package.json')
const prepare = read('packages/client-runtime/src/prepare-cli.ts')
const nodePrune = read('packages/client-runtime/src/node-runtime-prune.ts')
const finalPrune = read('packages/client-runtime/src/prune-node-cli.ts')
const imageIdentity = read('packages/client-runtime/src/image-identity.ts')
const smoke = read('packages/client-runtime/src/smoke-cli.ts')
const runtimeBundle = read('packages/client-runtime/src/runtime-bundle.ts')
const pnpmTool = read('packages/client-runtime/src/pnpm-tool.ts')
const pnpmEnsure = read('packages/client-runtime/src/ensure-pnpm-cli.ts')

const fail = (message) => {
  throw new Error(`[embedded-runtime] ${message}`)
}
const requireText = (source, marker, message) => {
  if (!source.includes(marker)) fail(message)
}
const forbidText = (source, marker, message) => {
  if (source.includes(marker)) fail(message)
}

if (tauri.bundle?.resources?.['resources/'] !== '') {
  fail('Tauri bundle must embed src-tauri/resources at the application resource root')
}

// Candidate must construct, publish, rehydrate and smoke the exact target Runtime
// that will be embedded in each desktop installer. Runtime/desktop artifact names
// now come from release-manifest.json through candidate-matrix.mjs, so this gate
// validates that semantic producer/consumer graph instead of requiring duplicated
// literal artifact names in workflow YAML.
const runtimeMatrix = runtimeCandidateMatrix()
const desktopMatrix = desktopCandidateMatrix()
if (!Array.isArray(runtimeMatrix.include) || runtimeMatrix.include.length === 0) {
  fail('release contract must produce at least one sealed Runtime candidate')
}
if (!Array.isArray(desktopMatrix.include) || desktopMatrix.include.length === 0) {
  fail('release contract must produce at least one desktop candidate')
}
for (const runtimeTarget of runtimeMatrix.include) {
  if (!runtimeTarget.candidateArtifact?.startsWith('tauri-runtime-')) {
    fail(`Runtime candidate artifact has invalid identity: ${runtimeTarget.candidateArtifact ?? 'missing'}`)
  }
  const consumers = desktopMatrix.include.filter(
    (desktopTarget) => desktopTarget.runtimeArtifact === runtimeTarget.candidateArtifact,
  )
  if (consumers.length === 0) {
    fail(`prepared Runtime ${runtimeTarget.candidateArtifact} has no desktop candidate consumer`)
  }
  for (const consumer of consumers) {
    if (consumer.runtimeKey !== runtimeTarget.runtimeKey) {
      fail(
        `desktop ${consumer.targetId} Runtime key ${consumer.runtimeKey} does not match producer ${runtimeTarget.runtimeKey}`,
      )
    }
  }
}
for (const desktopTarget of desktopMatrix.include) {
  const producer = runtimeMatrix.include.find(
    (runtimeTarget) => runtimeTarget.candidateArtifact === desktopTarget.runtimeArtifact,
  )
  if (!producer) {
    fail(`desktop ${desktopTarget.targetId} references missing Runtime artifact ${desktopTarget.runtimeArtifact}`)
  }
}

for (const [marker, message] of [
  ['pnpm --filter @dsh/client-runtime bundle-runtime', 'candidate must build each target Runtime from the pinned official source closure'],
  ['node scripts/release/candidate-matrix.mjs runtime', 'candidate must derive Runtime producers from the release contract'],
  ['node scripts/release/candidate-matrix.mjs desktop', 'candidate must derive desktop consumers from the release contract'],
  ['matrix: ${{ fromJSON(needs.validate.outputs.runtime_matrix) }}', 'candidate Runtime job must consume the contract-derived matrix'],
  ['matrix: ${{ fromJSON(needs.validate.outputs.desktop_matrix) }}', 'candidate desktop job must consume the contract-derived matrix'],
  ['name: ${{ matrix.candidateArtifact }}', 'candidate must publish target-specific artifacts using contract identities'],
  ['name: ${{ matrix.runtimeArtifact }}', 'desktop candidate must rehydrate the exact Runtime artifact selected by the contract'],
  ['path: apps/tauri/src-tauri/resources/dsh-runtime', 'candidate must place the prepared Runtime under Tauri resources'],
  ['pnpm --filter @dsh/client-runtime smoke-runtime -- --runtime-dir apps/tauri/src-tauri/resources/dsh-runtime', 'candidate must smoke-verify the exact Runtime copied into Tauri resources'],
  ['check-tauri-size-budget.mjs', 'candidate must enforce desktop package size budgets'],
]) {
  requireText(candidate, marker, message)
}
for (const forbidden of ['gateway-sidecar', 'bundle:sidecar', 'Bundle Gateway sidecar']) {
  forbidText(candidate, forbidden, 'candidate workflow must not package the removed Node Gateway sidecar')
}
if (Object.prototype.hasOwnProperty.call(tauriPackage.scripts || {}, 'bundle:sidecar')) {
  fail('Tauri package scripts must not expose the removed Node Gateway sidecar build')
}

// The candidate/smoke pipeline owns the expensive sealed-image verification.
// Native application startup only resolves the already packaged Runtime and
// binds the current generation to its immutable image identity. Repeating a
// node.exe/bin.js preflight here would reintroduce the user-visible "checking
// Node/runtime" startup path that the full offline package is designed to avoid.
if (!/resource_path\(\s*&?app\s*,\s*"dsh-runtime"\s*\)/.test(runtime)) {
  fail('native Runtime startup must resolve dsh-runtime from packaged resources')
}
requireText(runtime, 'fn load_runtime_image(', 'native Runtime startup must load the packaged Runtime metadata without a Node preflight')
requireText(runtime, 'image_identity', 'native Runtime startup must bind generations to the packaged image identity metadata')
for (const forbidden of [
  'fn verify_runtime_image(',
  '!node.is_file()',
  '!dsh.is_file()',
  'StartupPhase::RuntimeVerified',
]) {
  forbidText(runtime, forbidden, 'normal desktop startup must not repeat packaged Node/dsh Runtime verification')
}
for (const marker of [
  'ready.generation != expected_generation.id',
  'ready.nonce != expected_generation.nonce',
  'ready.image_identity != expected_generation.image_identity',
  'ready.pid != expected_pid',
  'ready.host != "127.0.0.1"',
]) {
  requireText(runtime, marker, `Runtime ready handshake missing required binding: ${marker}`)
}
for (const marker of [
  'HARNESSDOCK_RUNTIME_GENERATION',
  'HARNESSDOCK_RUNTIME_NONCE',
  'HARNESSDOCK_RUNTIME_IMAGE_IDENTITY',
  'generation,',
  'nonce,',
  'imageIdentity,',
]) {
  requireText(embeddedReadyProducer, marker, `embedded ready producer missing generation binding: ${marker}`)
}
for (const forbidden of ['resolve_system_node', 'HARNESSDOCK_USE_SYSTEM_NODE', 'HARNESSDOCK_NODE_BIN']) {
  forbidText(runtime, forbidden, 'formal desktop Runtime must not fall back to a system Node installation')
}
forbidText(runtime, 'first-run Runtime download', 'native first-launch Runtime startup must not contain a Runtime download path')

// RuntimeActor is the lifecycle source of truth. Transitional booleans may not
// return as a second state machine.
for (const marker of [
  'pub enum RuntimePhase',
  'pub struct RuntimeGeneration',
  'pub struct RuntimeLease',
  'process: Option<RuntimeProcess>',
  'lease: Option<RuntimeLease>',
  'cancellation: Option<(u64, CancellationToken)>',
]) {
  requireText(runtimeActor, marker, `RuntimeActor contract missing ${marker}`)
}
for (const legacyFlag of ['runtime_starting', 'runtime_restarting', 'runtime_stopping', 'harness_loading', 'web_action']) {
  forbidText(state, legacyFlag, `legacy lifecycle truth ${legacyFlag} must not return to AppState`)
}

// Resource ownership must be OS-native and kill descendants with the owner.
requireText(processControl, 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'Windows Runtime ownership must use a kill-on-close Job Object')
requireText(processControl, 'format!("-{pid}")', 'Unix Runtime ownership must terminate the managed process group')

// Gateway is native Rust. Reintroducing a Node sidecar or local bearer-admin API
// would reopen a second privileged process/control plane.
requireText(gatewayHost, 'struct NativeGateway', 'Gateway must be owned by the Rust Native GatewayActor')
requireText(gatewayHost, 'RuntimeLease', 'Native Gateway must bind the current RuntimeLease')
for (const forbidden of ['Command::new("node")', 'gateway-sidecar', 'admin bearer', 'Bearer admin']) {
  forbidText(gatewayHost, forbidden, 'Native Gateway must not reintroduce a Node sidecar or bearer admin plane')
}

// The remote Harness document receives only native window primitives and typed
// Host Protocol. It must never regain direct Runtime/update/quit permissions.
const remotePermissions = new Set(shellCapability.permissions || [])
if (!remotePermissions.has('host-protocol') || !remotePermissions.has('harness-shell')) {
  fail('Harness Web capability must expose minimum window primitives plus Host Protocol v2')
}
for (const forbidden of ['runtime-start', 'runtime-stop', 'runtime-maintenance', 'update-install', 'update-check', 'gateway-host', 'harness-window']) {
  if (remotePermissions.has(forbidden)) fail(`Harness Web must not receive direct privileged permission ${forbidden}`)
}
requireText(bridge, 'trusted_subject(&app, &window, envelope.subject)', 'Host Protocol execution must re-derive caller identity from the real WebView')
requireText(bridge, 'allowed_capabilities(', 'Host snapshot must return Capability Broker-filtered authority')

// Runtime tooling remains self-contained: dsh plugin/profile operations may not
// depend on a user-installed package manager.
if (!runtimePackage.scripts?.['bundle-runtime']?.includes('ensure-pnpm-cli.ts')) {
  fail('bundled Runtime build must embed pnpm for dsh profile-plugin management')
}
if (!runtimePackage.scripts?.['bundle-runtime']?.includes('prune-node-cli.ts')) {
  fail('bundled Runtime build must apply compact Node distribution pruning')
}
requireText(prepare, 'required official packed upstream tarballs', 'Runtime preparation must keep using the official packed dsh production closure')
if (!nodePrune.includes("path.join('lib', 'node_modules')") || !nodePrune.includes("path.join('node_modules', 'npm')")) {
  fail('compact Node pruning must remove bundled npm/corepack payloads without deleting dsh')
}
requireText(imageIdentity, "IDENTITY_ALGORITHM = 'sha256-v1'", 'Runtime image identity must use the frozen deterministic SHA-256 v1 contract')
requireText(finalPrune, 'computeRuntimeImageIdentity(dest)', 'the final Runtime build pass must seal the exact post-pruning image identity')
for (const [source, name] of [[smoke, 'smoke gate'], [runtimeBundle, 'runtime bundle installer']]) {
  requireText(source, 'assertRuntimeImageIdentity', `${name} must reject a Runtime whose sealed image identity no longer matches`)
}
for (const marker of ['firstLaunchRuntimeDownloadRequired = false', 'productionClosurePrunedBytes', 'buildCommit']) {
  requireText(finalPrune, marker, `sealed Runtime manifest missing ${marker}`)
}
requireText(pnpmTool, "PNPM_BUNDLE_VERSION = '11.7.0'", 'bundled pnpm must match the pinned DeepSeek Harness package-manager version')
requireText(pnpmTool, 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee', 'bundled pnpm tarball must be pinned by SHA-256')
requireText(pnpmEnsure, 'PNPM_BUNDLE_SHA256', 'pnpm preparation must verify the pinned tarball digest before extraction')
requireText(pnpmEnsure, 'cwd: tmpdir()', 'bundled pnpm smoke must run outside the workspace packageManager')
requireText(pnpmEnsure, 'pluginManagementReady = true', 'bundled Runtime manifest must record that plugin management tooling is ready')

// ExecEnvironment is explicit and child-scoped. The Host process PATH is not a
// Runtime integration surface, and production may not rediscover system Node.
forbidText(desktop, 'set_var("PATH"', 'desktop Host adapter must never mutate the process PATH')
forbidText(desktop, 'configure_embedded_runtime_tool_path', 'desktop Host adapter must not install a global Runtime tool PATH')
for (const marker of [
  'configure_embedded_runtime_environment',
  'command.get_program()',
  'root.join("tools").join("bin")',
  'command.env("PATH", joined)',
]) {
  requireText(platform, marker, `managed Runtime child ExecEnvironment missing ${marker}`)
}
for (const forbidden of ['HARNESSDOCK_USE_SYSTEM_NODE', 'HARNESSDOCK_NODE_BIN', 'find_usable_system_node', 'resolve_node']) {
  forbidText(platform, forbidden, 'formal desktop Runtime must not contain a production system Node fallback')
}

console.log('[embedded-runtime] Native Host + sealed Full Runtime invariants OK')
