#!/usr/bin/env node
/**
 * Toolchain bootstrap: assumes a working Node >=22.19 is already on PATH
 * (build.bat / build.sh guarantee that, downloading a portable Node if needed).
 *
 * Responsibilities:
 *   1. Ensure the exact pnpm version declared by packageManager
 *      (via corepack, fallback to npm -g)
 *   2. Run `pnpm install --frozen-lockfile --prefer-offline` when node_modules is missing
 *
 * Usage: node scripts/bootstrap.mjs [--skip-install]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skipInstall = process.argv.includes('--skip-install')
const product = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageManager = String(product.packageManager ?? '')
const pnpmMatch = /^pnpm@([^+\s]+)(?:\+.+)?$/.exec(packageManager)
if (!pnpmMatch) {
  console.error(`[bootstrap] ERROR: packageManager must pin pnpm exactly, got ${packageManager || 'missing'}.`)
  process.exit(1)
}
const requiredPnpm = pnpmMatch[1]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  return r.status === 0
}

// ---- 1. pnpm ------------------------------------------------------------
function pnpmVersion() {
  const r = spawnSync('pnpm', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

let pnpm = pnpmVersion()
if (pnpm !== requiredPnpm) {
  if (pnpm) {
    console.log(`[bootstrap] pnpm ${pnpm} does not match required ${requiredPnpm}; activating the pinned version...`)
  } else {
    console.log(`[bootstrap] pnpm not found; activating pinned pnpm ${requiredPnpm}...`)
  }

  let activated = false
  if (run('corepack', ['enable'])) {
    activated = run('corepack', ['prepare', `pnpm@${requiredPnpm}`, '--activate'])
  }

  pnpm = pnpmVersion()
  if (!activated || pnpm !== requiredPnpm) {
    console.log(`[bootstrap] corepack did not activate pnpm ${requiredPnpm}; falling back to npm install -g...`)
    if (!run('npm', ['install', '-g', `pnpm@${requiredPnpm}`])) {
      console.error(`[bootstrap] ERROR: unable to provision pnpm ${requiredPnpm}.`)
      process.exit(1)
    }
    pnpm = pnpmVersion()
  }

  if (pnpm !== requiredPnpm) {
    console.error(`[bootstrap] ERROR: pnpm ${requiredPnpm} is required, but ${pnpm ?? 'no pnpm'} is active after provisioning.`)
    process.exit(1)
  }
}
console.log(`[bootstrap] pnpm ${pnpm} (pinned by packageManager)`)

// ---- 2. dependencies ----------------------------------------------------
if (skipInstall) {
  console.log('[bootstrap] --skip-install: skip dependency check')
} else if (!existsSync(path.join(repoRoot, 'node_modules'))) {
  console.log('[bootstrap] node_modules missing, running pnpm install --frozen-lockfile --prefer-offline ...')
  if (!run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])) {
    console.error('[bootstrap] ERROR: pnpm install failed.')
    process.exit(1)
  }
} else {
  console.log('[bootstrap] node_modules present, skip install')
}

console.log('[bootstrap] toolchain ready.')
