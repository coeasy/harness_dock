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

if (tauri.bundle?.resources?.['resources/'] !== '') {
  fail('Tauri bundle must embed src-tauri/resources at the application resource root')
}
if (!candidate.includes('Prepare per-platform bundled runtime')) {
  fail('candidate must prepare a per-platform bundled Runtime before desktop packaging')
}
if (!candidate.includes('Download prepared runtime into Tauri resources')) {
  fail('candidate must place the prepared Runtime under Tauri resources')
}
if (!candidate.includes('Verify full runtime before packaging')) {
  fail('candidate must smoke-verify the embedded Full Runtime before packaging')
}
if (!runtime.includes('resource_path(&app, "dsh-runtime")')) {
  fail('native Runtime startup must resolve dsh-runtime from packaged resources')
}
if (!runtimePackage.scripts?.['bundle-runtime']?.includes('prune-node-cli.ts')) {
  fail('bundled Runtime build must apply compact Node distribution pruning')
}
if (!prepare.includes('required official packed upstream tarballs')) {
  fail('Runtime preparation must keep using the official packed dsh production closure')
}
if (!nodePrune.includes("path.join('lib', 'node_modules')") || !nodePrune.includes("path.join('node_modules', 'npm')")) {
  fail('compact Node pruning must remove bundled package-manager payloads on Unix and Windows')
}
if (runtime.includes('download Node') || runtime.includes('download dsh')) {
  fail('native first-launch Runtime startup must not download Node or dsh')
}

console.log('[embedded-runtime] self-contained Full Runtime contract OK')
