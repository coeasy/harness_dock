import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
const candidate = read('.github/workflows/tauri-candidate.yml')
const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
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

const requireCandidateMarker = (marker, message) => {
  if (!candidate.includes(marker)) fail(message)
}

if (tauri.bundle?.resources?.['resources/'] !== '') {
  fail('Tauri bundle must embed src-tauri/resources at the application resource root')
}

// Check stable implementation commands/paths rather than human-readable step
// labels. Step titles are documentation and may be renamed without changing the
// Full Runtime release contract.
requireCandidateMarker(
  'pnpm --filter @dsh/client-runtime bundle-runtime',
  'candidate must build each target Runtime from the pinned official source closure',
)
requireCandidateMarker(
  'name: tauri-runtime-${{ matrix.artifact }}',
  'candidate must publish a target-specific prepared Runtime artifact',
)
requireCandidateMarker(
  'path: apps/tauri/src-tauri/resources/dsh-runtime',
  'candidate must place the prepared Runtime under Tauri resources',
)
requireCandidateMarker(
  'pnpm --filter @dsh/client-runtime smoke-runtime -- --runtime-dir apps/tauri/src-tauri/resources/dsh-runtime',
  'candidate must smoke-verify the exact Runtime copied into Tauri resources',
)
requireCandidateMarker(
  'Verify full runtime before packaging',
  'candidate must verify the embedded Full Runtime before desktop packaging',
)

if (!runtime.includes('resource_path(&app, "dsh-runtime")')) {
  fail('native Runtime startup must resolve dsh-runtime from packaged resources')
}
if (!runtimePackage.scripts?.['bundle-runtime']?.includes('ensure-pnpm-cli.ts')) {
  fail('bundled Runtime build must embed pnpm for dsh profile-plugin management')
}
if (!runtimePackage.scripts?.['bundle-runtime']?.includes('prune-node-cli.ts')) {
  fail('bundled Runtime build must apply compact Node distribution pruning')
}
if (!prepare.includes('required official packed upstream tarballs')) {
  fail('Runtime preparation must keep using the official packed dsh production closure')
}
if (
  !nodePrune.includes("path.join('lib', 'node_modules')") ||
  !nodePrune.includes("path.join('node_modules', 'npm')")
) {
  fail('compact Node pruning must remove bundled npm/corepack payloads without deleting dsh')
}
if (!imageIdentity.includes("IDENTITY_ALGORITHM = 'sha256-v1'")) {
  fail('Runtime image identity must use the frozen deterministic SHA-256 v1 contract')
}
if (!finalPrune.includes('computeRuntimeImageIdentity(dest)')) {
  fail('the final Runtime build pass must seal the exact post-pruning image identity')
}
for (const [source, name] of [
  [smoke, 'smoke gate'],
  [runtimeBundle, 'runtime bundle installer'],
]) {
  if (!source.includes('assertRuntimeImageIdentity')) {
    fail(`${name} must reject a Runtime whose sealed image identity no longer matches`)
  }
}
if (!finalPrune.includes('firstLaunchRuntimeDownloadRequired = false')) {
  fail('sealed Runtime manifest must explicitly prohibit first-launch Runtime download')
}
if (!finalPrune.includes('productionClosurePrunedBytes')) {
  fail('sealed Runtime manifest must retain production-closure pruning accounting')
}
if (!finalPrune.includes('buildCommit')) {
  fail('sealed Runtime manifest must bind the image to the HarnessDock build commit')
}
if (!pnpmTool.includes("PNPM_BUNDLE_VERSION = '11.7.0'")) {
  fail('bundled pnpm must match the pinned DeepSeek Harness package-manager version')
}
if (!pnpmTool.includes('deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee')) {
  fail('bundled pnpm tarball must be pinned by SHA-256')
}
if (!pnpmEnsure.includes('PNPM_BUNDLE_SHA256')) {
  fail('pnpm preparation must verify the pinned tarball digest before extraction')
}
if (!pnpmEnsure.includes('pluginManagementReady = true')) {
  fail('bundled Runtime manifest must record that plugin management tooling is ready')
}
if (!desktop.includes('configure_embedded_runtime_tool_path')) {
  fail('desktop adapter must expose embedded Runtime tools to dsh child processes')
}
if (!desktop.includes('runtime.join("tools").join("bin")')) {
  fail('desktop adapter must prepend the embedded pnpm shim directory to PATH')
}
if (runtime.includes('download Node') || runtime.includes('download dsh')) {
  fail('native first-launch Runtime startup must not download Node or dsh')
}

console.log('[embedded-runtime] self-contained sealed Full Runtime + plugin-tool contract OK')
