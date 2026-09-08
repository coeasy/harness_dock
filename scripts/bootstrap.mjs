#!/usr/bin/env node
/**
 * Toolchain bootstrap: assumes a working supported Node is already on PATH
 * (build.bat / build.sh guarantee that, preferring a compatible system Node
 * and falling back to a verified portable Node when needed).
 *
 * Responsibilities:
 *   1. Reuse an exact pnpm from PATH when available; otherwise provision the
 *      exact packageManager version under .local-tools without mutating global
 *      Corepack/npm state.
 *   2. Reconcile the workspace with `pnpm install --frozen-lockfile --prefer-offline`
 *      on every normal invocation. This keeps an existing node_modules correct
 *      after git pulls/branch switches instead of trusting directory presence.
 *
 * Usage: node scripts/bootstrap.mjs [--skip-install]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skipInstall = process.argv.includes('--skip-install')
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageManager = String(rootPackage.packageManager ?? '')
const pnpmMatch = /^pnpm@([^\s]+)$/.exec(packageManager)
if (!pnpmMatch) {
  console.error(`[bootstrap] ERROR: package.json packageManager must pin pnpm exactly; got ${packageManager || 'missing'}`)
  process.exit(1)
}
const expectedPnpmVersion = pnpmMatch[1]
const toolRoot = path.join(repoRoot, '.local-tools')
const localPnpmRoot = path.join(toolRoot, `pnpm-${expectedPnpmVersion}`)
const localPnpmBin = path.join(localPnpmRoot, 'node_modules', '.bin')
const localPnpmCommand = path.join(localPnpmBin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
const pnpmBinFile = path.join(toolRoot, 'pnpm-bin.txt')
const systemPnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  return r.status === 0
}

function commandVersion(command) {
  const r = spawnSync(command, ['--version'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  return r.status === 0 ? String(r.stdout || '').trim() : null
}

function exactPnpm(command) {
  return commandVersion(command) === expectedPnpmVersion
}

mkdirSync(toolRoot, { recursive: true })
let pnpmCommand = systemPnpmCommand
let pnpmSource = 'system PATH'
let pnpm = commandVersion(systemPnpmCommand)

if (pnpm !== expectedPnpmVersion) {
  console.log(
    `[bootstrap] pnpm ${pnpm ?? 'missing'} does not match packageManager pnpm@${expectedPnpmVersion}; resolving repository-local exact pnpm...`,
  )

  if (!exactPnpm(localPnpmCommand)) {
    console.log(`[bootstrap] provisioning pnpm ${expectedPnpmVersion} under ${localPnpmRoot}`)
    rmSync(localPnpmRoot, { recursive: true, force: true })
    mkdirSync(localPnpmRoot, { recursive: true })
    const installed = run('npm', [
      'install',
      '--prefix', localPnpmRoot,
      '--no-save',
      '--no-fund',
      '--no-audit',
      '--package-lock=false',
      `pnpm@${expectedPnpmVersion}`,
    ])
    if (!installed || !existsSync(localPnpmCommand) || !exactPnpm(localPnpmCommand)) {
      console.error(
        `[bootstrap] ERROR: unable to provision isolated pnpm ${expectedPnpmVersion} under .local-tools. Check npm/network access or install pnpm@${expectedPnpmVersion} on PATH.`,
      )
      process.exit(1)
    }
  } else {
    console.log(`[bootstrap] reusing cached repository-local pnpm ${expectedPnpmVersion}`)
  }

  pnpmCommand = localPnpmCommand
  pnpmSource = '.local-tools'
  pnpm = commandVersion(pnpmCommand)
  writeFileSync(pnpmBinFile, `${localPnpmBin}\n`, 'utf8')
} else {
  // Prevent a stale repository-local path from shadowing an exact pnpm that is
  // already available on PATH for this invocation.
  rmSync(pnpmBinFile, { force: true })
}

console.log(`[bootstrap] pnpm ${pnpm} (exact packageManager match; source=${pnpmSource})`)

if (skipInstall) {
  console.log('[bootstrap] --skip-install: skip workspace reconciliation')
} else {
  console.log('[bootstrap] reconciling workspace with frozen lockfile (prefer offline) ...')
  if (!run(pnpmCommand, ['install', '--frozen-lockfile', '--prefer-offline'])) {
    console.error('[bootstrap] ERROR: pnpm install failed.')
    process.exit(1)
  }
}

console.log('[bootstrap] toolchain ready.')
