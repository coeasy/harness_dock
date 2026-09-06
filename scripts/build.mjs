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
import { existsSync, readFileSync } from 'node:fs'
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
const product = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageManager = String(product.packageManager ?? '')
const pnpmMatch = /^pnpm@([^+\s]+)(?:\+.+)?$/.exec(packageManager)
if (!pnpmMatch) {
  console.error(`\n[build] ERROR: packageManager must pin pnpm exactly, got ${packageManager || 'missing'}.`)
  process.exit(1)
}
const requiredPnpmVersion = pnpmMatch[1]

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

function commandResult(command, args = ['--version'], extraPath = null) {
  const env = { ...process.env }
  if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH ?? ''}`
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env,
  })
}

function commandWorks(command, args = ['--version'], extraPath = null) {
  return commandResult(command, args, extraPath).status === 0
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

function activeTauriCliVersion(extraPath = null) {
  const result = commandResult(cargoCommand, ['tauri', '--version'], extraPath)
  if (result.status !== 0) return null
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const match = /(?:tauri-cli|cargo-tauri)\s+v?(\d+\.\d+\.\d+)/i.exec(output) ?? /\b(\d+\.\d+\.\d+)\b/.exec(output)
  return match?.[1] ?? null
}

function ensureTauriCli() {
  if (!commandWorks(cargoCommand, ['--version'])) {
    fail('Rust/Cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs and the Tauri 2 platform prerequisites.')
  }

  const globalVersion = activeTauriCliVersion()
  if (globalVersion === tauriCliVersion) {
    console.log(`[build] using tauri-cli ${globalVersion}`)
    return
  }
  if (globalVersion) {
    console.log(`[build] ignoring tauri-cli ${globalVersion}; local builds require ${tauriCliVersion}`)
  }

  const localBinary = path.join(localTauriBin, process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri')
  const cachedVersion = existsSync(localBinary) ? activeTauriCliVersion(localTauriBin) : null
  if (cachedVersion === tauriCliVersion) {
    prependPath(localTauriBin)
    console.log(`[build] using cached local tauri-cli ${tauriCliVersion}`)
    return
  }

  console.log(`[build] installing isolated tauri-cli ${tauriCliVersion} under ${localTauriRoot}`)
  run(
    cargoCommand,
    ['install', 'tauri-cli', '--version', tauriCliVersion, '--locked', '--root', localTauriRoot],
    `install tauri-cli ${tauriCliVersion}`,
  )
  prependPath(localTauriBin)
  const installedVersion = activeTauriCliVersion()
  if (installedVersion !== tauriCliVersion) {
    fail(`tauri-cli ${tauriCliVersion} was installed but active cargo tauri reports ${installedVersion ?? 'unavailable'}`)
  }
}

run(process.execPath, ['scripts/node-version-check.cjs'], 'check build-time Node version')

const pnpmVersion = spawnSync(pnpmCommand, ['--version'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  encoding: 'utf8',
})
const activePnpmVersion = pnpmVersion.status === 0 ? String(pnpmVersion.stdout ?? '').trim() : null
if (activePnpmVersion !== requiredPnpmVersion) {
  fail(`pnpm ${requiredPnpmVersion} is required by packageManager, but ${activePnpmVersion ?? 'pnpm is unavailable'}; run scripts/bootstrap.mjs or use scripts/build.bat / scripts/build.sh`)
}
console.log(`[build] using pinned pnpm ${activePnpmVersion}`)

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
