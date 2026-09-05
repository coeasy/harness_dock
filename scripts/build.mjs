#!/usr/bin/env node
/**
 * One-click local Tauri client build.
 *
 * Local builds prepare the exact sealed Harness Runtime for the host platform,
 * build both plugins, verify the runtime can serve Harness Web, check the Rust
 * host, and finally produce the native Tauri bundle.
 *
 * System Node/pnpm/cargo are build tools only. The installed desktop client
 * starts from its bundled Node+dsh Runtime and does not inspect system Node.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const cargoCommand = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const tauriCliVersion = '2.11.4'
const localTauriRoot = path.join(repoRoot, '.local-tools', `tauri-cli-${tauriCliVersion}`)
const localTauriBin = path.join(localTauriRoot, 'bin')

const { values } = parseArgs({
  options: {
    'skip-install': { type: 'boolean' },
    'skip-tests': { type: 'boolean' },
    'skip-runtime': { type: 'boolean' },
    'force-runtime': { type: 'boolean' },
    'source-runtime': { type: 'boolean' },
    'check-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/build.mjs [options]

Options:
      --skip-install   skip pnpm install
      --skip-tests     skip unit tests
      --skip-runtime   do not prepare/verify apps/tauri/src-tauri/resources/dsh-runtime
      --force-runtime  rebuild/redownload the sealed runtime
      --source-runtime build the sealed runtime from the exact pinned upstream source
      --check-only     prepare everything and run the Rust host check without packaging
  -h, --help           show this help

Normal first-run usage:
  Windows: scripts\\build.bat
  macOS/Linux: ./scripts/build.sh

Cross-platform release artifacts remain produced by .github/workflows/tauri-candidate.yml.`)
  process.exit(0)
}

function fail(message) {
  console.error(`\n[build] ERROR: ${message}`)
  process.exit(1)
}

function commandWorks(command, args = ['--version'], extraPath = null) {
  const env = { ...process.env }
  if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH ?? ''}`
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    env,
  })
  return result.status === 0
}

function run(command, args, label, options = {}) {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`)
}

function prependPath(directory) {
  process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ''}`
}

function ensureTauriCli() {
  if (!commandWorks(cargoCommand, ['--version'])) {
    fail('Rust/Cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs and the Tauri 2 platform prerequisites.')
  }

  if (commandWorks(cargoCommand, ['tauri', '--version'])) return

  const localBinary = path.join(localTauriBin, process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri')
  if (existsSync(localBinary) && commandWorks(cargoCommand, ['tauri', '--version'], localTauriBin)) {
    prependPath(localTauriBin)
    console.log(`[build] using cached local tauri-cli ${tauriCliVersion}`)
    return
  }

  console.log(`[build] tauri-cli not found; installing isolated tauri-cli ${tauriCliVersion} under ${localTauriRoot}`)
  run(
    cargoCommand,
    ['install', 'tauri-cli', '--version', tauriCliVersion, '--locked', '--root', localTauriRoot],
    `install tauri-cli ${tauriCliVersion}`,
  )
  prependPath(localTauriBin)
  if (!commandWorks(cargoCommand, ['tauri', '--version'])) {
    fail(`tauri-cli ${tauriCliVersion} was installed but cargo tauri is still unavailable`)
  }
}

run(process.execPath, ['scripts/node-version-check.cjs'], 'check build-time Node version')

const pnpmVersion = spawnSync(pnpmCommand, ['--version'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  encoding: 'utf8',
})
if (pnpmVersion.status !== 0) {
  fail('pnpm not found on PATH; run scripts/bootstrap.mjs or use scripts/build.bat / scripts/build.sh')
}

ensureTauriCli()

if (!values['skip-install']) {
  run(pnpmCommand, ['install', '--frozen-lockfile', '--prefer-offline'], 'pnpm install')
}
if (!values['skip-tests']) run(pnpmCommand, ['test'], 'unit tests')

run(pnpmCommand, ['--filter', '@dsh/plugin-embedded-client', 'build'], 'build embedded client plugin')
run(pnpmCommand, ['--filter', '@dsh/plugin-harness-shell', 'build'], 'build independent Harness Shell plugin')

if (!values['skip-runtime']) {
  const runtimeArgs = ['scripts/prepare-local-runtime.mjs']
  if (values['force-runtime']) runtimeArgs.push('--force')
  if (values['source-runtime']) runtimeArgs.push('--source-only')
  run(process.execPath, runtimeArgs, 'prepare sealed local Harness Runtime')
  run(
    pnpmCommand,
    [
      '--filter', '@dsh/client-runtime', 'smoke-runtime', '--',
      '--runtime-dir', 'apps/tauri/src-tauri/resources/dsh-runtime',
      '--plugin', 'packages/plugin-embedded-client/lib/index.js',
    ],
    'verify sealed Runtime + Harness Web readiness',
  )
}

run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:check'], 'check Tauri Rust host')
if (!values['check-only']) run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:build'], 'build Tauri client')

console.log('\n[build] Tauri build completed.')
