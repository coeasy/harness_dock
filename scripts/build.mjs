#!/usr/bin/env node
/**
 * HarnessDock desktop build orchestrator.
 *
 * Shared responsibilities stay here; platform/architecture differences live in
 * build-targets.mjs. The installed desktop client always consumes its own sealed
 * Node+dsh Runtime. System Node/pnpm/Rust/Tauri are build-time tools only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, tauriBundleArgument } from './build-targets.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const versions = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'versions.json'), 'utf8'))
const target = resolveDesktopBuildTarget()
const packageManager = String(rootPackage.packageManager ?? '')
const pnpmMatch = /^pnpm@([^\s]+)$/.exec(packageManager)
if (!pnpmMatch) throw new Error(`package.json packageManager must pin pnpm exactly; got ${packageManager || 'missing'}`)
const expectedPnpmVersion = pnpmMatch[1]
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const cargoCommand = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const tauriCliVersion = String(versions.tauriCli ?? '')
if (!/^\d+\.\d+\.\d+$/.test(tauriCliVersion)) {
  throw new Error(`scripts/versions.json must pin tauriCli exactly; got ${tauriCliVersion || 'missing'}`)
}
const localTauriRoot = path.join(repoRoot, '.local-tools', `tauri-cli-${tauriCliVersion}`)
const localTauriBin = path.join(localTauriRoot, 'bin')
const tauriAppRoot = path.join(repoRoot, 'apps', 'tauri')

const { values } = parseArgs({
  options: {
    'skip-install': { type: 'boolean' },
    'skip-tests': { type: 'boolean' },
    'skip-runtime': { type: 'boolean' },
    'skip-runtime-prepare': { type: 'boolean' },
    'force-runtime': { type: 'boolean' },
    'source-runtime': { type: 'boolean' },
    'check-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/build.mjs [options]

Target selected from the host OS/arch:
  ${target.id}: runtime=${target.runtimeKey}, bundles=${target.bundles.join(',')}

Options:
      --skip-install          skip pnpm install (caller must provide exact workspace state)
      --skip-tests            skip unit tests
      --skip-runtime-prepare  do not download/rebuild Runtime; still require full Runtime smoke
      --force-runtime         redownload/rebuild the exact sealed Runtime
      --source-runtime        explicitly build Runtime from the pinned upstream tag+commit
      --check-only            stop after plugins + Rust host + Runtime/Harness Web gates
  -h, --help                  show this help

Deprecated:
      --skip-runtime          rejected because packaging without Runtime verification is unsafe

Platform packaging policy:
  Windows x64 : NSIS only
  Linux x64   : DEB + AppImage
  macOS x64   : .app only (DMG remains release-workflow owned)
  macOS arm64 : .app only (DMG remains release-workflow owned)

Normal local builds prefer an exact published sealed Runtime with a trusted
SHA-256 digest. If no trusted matching bundle is available, the build falls back
to the exact pinned upstream tag+commit and feeds its official dsh/vendor packs
through the same sealed Runtime builder and verification path. Use
--source-runtime to skip release lookup and force that pinned source path.`)
  process.exit(0)
}

function fail(message) {
  console.error(`\n[build] ERROR: ${message}`)
  process.exit(1)
}

if (values['skip-runtime']) {
  fail('--skip-runtime is no longer supported; use --skip-runtime-prepare to reuse an existing Runtime while still enforcing integrity and Harness Web smoke')
}
if (values['skip-runtime-prepare'] && values['force-runtime']) {
  fail('--skip-runtime-prepare cannot be combined with --force-runtime')
}
if (values['skip-runtime-prepare'] && values['source-runtime']) {
  fail('--skip-runtime-prepare cannot be combined with --source-runtime')
}

function commandResult(command, args = ['--version'], extraPath = null) {
  const env = { ...process.env }
  if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH ?? ''}`
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env,
  })
}

function commandWorks(command, args = ['--version'], extraPath = null) {
  return commandResult(command, args, extraPath).status === 0
}

function tauriVersion(extraPath = null) {
  const result = commandResult(cargoCommand, ['tauri', '--version'], extraPath)
  if (result.status !== 0) return null
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const match = /(?:tauri-cli\s+)?(\d+\.\d+\.\d+)/i.exec(output)
  return match?.[1] ?? null
}

function runStatus(command, args, label, options = {}) {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.error) console.error(`[build] ${label}: ${result.error.message}`)
  return result.status ?? 1
}

function run(command, args, label, options = {}) {
  const status = runStatus(command, args, label, options)
  if (status !== 0) fail(`${label} failed with exit code ${status}`)
}

function prependPath(directory) {
  process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ''}`
}

function ensureCargo() {
  if (!commandWorks(cargoCommand, ['--version'])) {
    fail('Rust/Cargo was not found on PATH. Install the pinned rust-toolchain.toml toolchain and the Tauri 2 system prerequisites for this platform.')
  }
}

function ensureTauriCli() {
  ensureCargo()

  const globalVersion = tauriVersion()
  if (globalVersion === tauriCliVersion) {
    console.log(`[build] using tauri-cli ${tauriCliVersion} from PATH`)
    return
  }
  if (globalVersion) {
    console.log(`[build] ignoring tauri-cli ${globalVersion} from PATH; exact ${tauriCliVersion} is required`)
  }

  const localBinary = path.join(localTauriBin, process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri')
  if (existsSync(localBinary) && tauriVersion(localTauriBin) === tauriCliVersion) {
    prependPath(localTauriBin)
    console.log(`[build] using cached local tauri-cli ${tauriCliVersion}`)
    return
  }

  console.log(`[build] installing isolated tauri-cli ${tauriCliVersion} under ${localTauriRoot}`)
  run(
    cargoCommand,
    ['install', 'tauri-cli', '--version', tauriCliVersion, '--locked', '--root', localTauriRoot, '--force'],
    `install tauri-cli ${tauriCliVersion}`,
  )
  prependPath(localTauriBin)
  const installedVersion = tauriVersion()
  if (installedVersion !== tauriCliVersion) {
    fail(`tauri-cli ${tauriCliVersion} was installed but cargo tauri reports ${installedVersion ?? 'unavailable'}`)
  }
}

function runtimePrepareArgs(force = false) {
  const args = ['scripts/prepare-local-runtime.mjs']
  if (force) args.push('--force')
  if (values['source-runtime']) {
    args.push('--source-only')
  }
  // The user-facing local build must remain usable from a clean clone before a
  // matching release Runtime exists. prepare-local-runtime already verifies a
  // trusted published bundle first, then falls back to the exact pinned source
  // checkout and the same sealed Runtime builder/identity checks.
  return args
}

function verifyRuntime() {
  const smokeArgs = [
    '--filter', '@dsh/client-runtime', 'smoke-runtime', '--',
    '--runtime-dir', 'apps/tauri/src-tauri/resources/dsh-runtime',
    '--plugin', 'packages/plugin-embedded-client/lib/index.js',
  ]
  const firstSmoke = runStatus(
    pnpmCommand,
    smokeArgs,
    `verify ${target.runtimeKey} sealed Runtime + Harness Web readiness`,
  )
  if (firstSmoke === 0) return

  if (values['skip-runtime-prepare']) {
    fail('existing Runtime failed verification and --skip-runtime-prepare forbids repair')
  }

  console.warn('[build] Runtime verification failed; refreshing the same target Runtime once and re-verifying.')
  run(
    process.execPath,
    runtimePrepareArgs(true),
    `force-refresh ${target.runtimeKey} sealed Runtime after verification failure`,
  )
  run(
    pnpmCommand,
    smokeArgs,
    `verify refreshed ${target.runtimeKey} sealed Runtime + Harness Web readiness`,
  )
}

console.log(`[build] target=${target.id} runtime=${target.runtimeKey} packaging=${target.artifactKind}`)
run(process.execPath, ['scripts/node-version-check.cjs'], 'check build-time Node version')

const pnpmVersion = commandResult(pnpmCommand, ['--version'])
const actualPnpmVersion = pnpmVersion.status === 0 ? String(pnpmVersion.stdout ?? '').trim() : null
if (actualPnpmVersion !== expectedPnpmVersion) {
  fail(
    `pnpm ${actualPnpmVersion ?? 'not found'} does not match packageManager pnpm@${expectedPnpmVersion}; run scripts/bootstrap.mjs or use scripts/build.bat / scripts/build.sh`,
  )
}
console.log(`[build] using exact pnpm ${actualPnpmVersion}`)

if (!values['skip-install']) {
  run(pnpmCommand, ['install', '--frozen-lockfile', '--prefer-offline'], 'pnpm install')
}
if (!values['skip-tests']) run(pnpmCommand, ['test'], 'unit tests')

run(pnpmCommand, ['--filter', '@dsh/plugin-embedded-client', 'build'], 'build embedded client plugin')
run(pnpmCommand, ['--filter', '@dsh/plugin-harness-shell', 'build'], 'build independent Harness Shell plugin')

// Rust compilation is a fast deterministic host gate and must not wait behind
// Runtime downloads/source/network smoke. It also does not require tauri-cli.
ensureCargo()
run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:check'], `check ${target.id} Tauri Rust host`)

if (!values['skip-runtime-prepare']) {
  run(
    process.execPath,
    runtimePrepareArgs(Boolean(values['force-runtime'])),
    values['source-runtime']
      ? `build ${target.runtimeKey} sealed Runtime from pinned upstream source`
      : `prepare ${target.runtimeKey} sealed Runtime from trusted release or pinned source fallback`,
  )
}
verifyRuntime()

if (values['check-only']) {
  console.log(`\n[build] CHECK PASSED for ${target.id}: plugins + Rust host + ${target.runtimeKey} Runtime/Harness Web`)
  process.exit(0)
}

// Tauri CLI is a packaging dependency, not a Rust-check or Runtime dependency.
ensureTauriCli()
const bundleArgument = tauriBundleArgument(target)
console.log(`[build] ${target.id} packaging policy: ${bundleArgument}`)
run(
  cargoCommand,
  ['tauri', 'build', '--bundles', bundleArgument],
  `build ${target.id} Tauri ${target.artifactKind}`,
  { cwd: tauriAppRoot },
)

console.log(`\n[build] SUCCESS for ${target.id}`)
console.log(`[build] Native bundle output: ${path.join(tauriAppRoot, 'src-tauri', 'target', 'release', 'bundle')}`)
