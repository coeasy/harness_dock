#!/usr/bin/env node
/**
 * Toolchain bootstrap: assumes a working supported Node is already on PATH
 * (build.bat / build.sh guarantee that, downloading a portable Node if needed).
 *
 * Responsibilities:
 *   1. Ensure the exact pnpm version declared by packageManager
 *   2. Reconcile the workspace with `pnpm install --frozen-lockfile --prefer-offline`
 *      on every normal invocation. This keeps an existing node_modules correct
 *      after git pulls/branch switches instead of trusting directory presence.
 *
 * Usage: node scripts/bootstrap.mjs [--skip-install]
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  return r.status === 0
}

function pnpmVersion() {
  const r = spawnSync('pnpm', ['--version'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  return r.status === 0 ? String(r.stdout || '').trim() : null
}

function hasExactPnpm() {
  return pnpmVersion() === expectedPnpmVersion
}

let pnpm = pnpmVersion()
if (pnpm !== expectedPnpmVersion) {
  console.log(
    `[bootstrap] pnpm ${pnpm ?? 'missing'} does not match packageManager pnpm@${expectedPnpmVersion}; provisioning exact version...`,
  )

  let provisioned = false
  if (run('corepack', ['enable'])) {
    provisioned = run('corepack', ['prepare', `pnpm@${expectedPnpmVersion}`, '--activate']) && hasExactPnpm()
  }

  if (!provisioned) {
    console.log(`[bootstrap] corepack did not activate pnpm ${expectedPnpmVersion}; falling back to npm install -g...`)
    provisioned =
      run('npm', ['install', '-g', `pnpm@${expectedPnpmVersion}`, '--no-fund', '--no-audit']) && hasExactPnpm()
  }

  if (!provisioned) {
    console.error(
      `[bootstrap] ERROR: unable to provision exact pnpm ${expectedPnpmVersion}. Check Node/npm permissions or install pnpm@${expectedPnpmVersion} manually.`,
    )
    process.exit(1)
  }
  pnpm = pnpmVersion()
}

console.log(`[bootstrap] pnpm ${pnpm} (exact packageManager match)`)

if (skipInstall) {
  console.log('[bootstrap] --skip-install: skip workspace reconciliation')
} else {
  console.log('[bootstrap] reconciling workspace with frozen lockfile (prefer offline) ...')
  if (!run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])) {
    console.error('[bootstrap] ERROR: pnpm install failed.')
    process.exit(1)
  }
}

console.log('[bootstrap] toolchain ready.')
