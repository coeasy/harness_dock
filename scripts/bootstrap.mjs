#!/usr/bin/env node
/**
 * Toolchain bootstrap: assumes a working Node >=22.19 is already on PATH
 * (build.bat / build.sh guarantee that, downloading a portable Node if needed).
 *
 * Responsibilities:
 *   1. Ensure pnpm 10 (via corepack, fallback to npm -g)
 *   2. Run `pnpm install --frozen-lockfile --prefer-offline` when node_modules is missing
 *
 * Usage: node scripts/bootstrap.mjs [--skip-install]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skipInstall = process.argv.includes('--skip-install')

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
if (!pnpm) {
  console.log('[bootstrap] pnpm not found, activating via corepack...')
  if (!run('corepack', ['enable'])) {
    console.log('[bootstrap] corepack failed, falling back to npm install -g pnpm...')
    if (!run('npm', ['install', '-g', 'pnpm@10.12.0'])) {
      console.error('[bootstrap] ERROR: unable to provision pnpm. Install pnpm 10 manually.')
      process.exit(1)
    }
  } else {
    run('corepack', ['prepare', 'pnpm@10.12.0', '--activate'])
  }
  pnpm = pnpmVersion()
  if (!pnpm) {
    console.error('[bootstrap] ERROR: pnpm still unavailable after provisioning.')
    process.exit(1)
  }
}
console.log(`[bootstrap] pnpm ${pnpm}`)

// ---- 2. dependencies ----------------------------------------------------
if (skipInstall) {
  console.log('[bootstrap] --skip-install: skip dependency check')
} else if (!existsSync(path.join(repoRoot, 'node_modules'))) {
  console.log('[bootstrap] node_modules missing, running pnpm install --frozen-lockfile --prefer-offline ...')
  if (!run('pnpm', ['install', '--frozen-lockfile'])) {
    console.error('[bootstrap] ERROR: pnpm install failed.')
    process.exit(1)
  }
} else {
  console.log('[bootstrap] node_modules present, skip install')
}

console.log('[bootstrap] toolchain ready.')
