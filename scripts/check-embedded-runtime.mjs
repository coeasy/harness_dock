import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
const candidate = read('.github/workflows/tauri-candidate.yml')
const runtime = read('apps/tauri/src-tauri/src/runtime.rs')
const runtimePackage = readJson('packages/client-runtime/package.json')
const prepare = read('packages/client-runtime/src/prepare-cli.ts')
const nodePrune = read('packages/client-runtime/src/node-runtime-prune.ts')

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
  fail('compact Node pruning must remove bundled package-manager payloads on Unix and Windows')
}
if (runtime.includes('download Node') || runtime.includes('download dsh')) {
  fail('native first-launch Runtime startup must not download Node or dsh')
}

console.log('[embedded-runtime] self-contained Full Runtime contract OK')
