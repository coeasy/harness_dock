#!/usr/bin/env node
/**
 * Toolchain bootstrap: assumes a working Node >=22.19 is already on PATH
 * (build.bat / build.sh guarantee that, downloading a portable Node if needed).
 *
 * Responsibilities:
 *   1. Ensure the exact pnpm version declared by packageManager.
 *      Prefer an already-correct pnpm or Corepack, then fall back to an
 *      isolated repo-local pnpm under .local-tools (never require npm -g).
 *   2. Run `pnpm install --frozen-lockfile --prefer-offline` when node_modules is missing.
 *
 * Usage: node scripts/bootstrap.mjs [--skip-install]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const localToolsRoot = path.join(repoRoot, '.local-tools')
const localPnpmRoot = path.join(localToolsRoot, `pnpm-${requiredPnpm}`)
const localPnpmBinDir = path.join(localPnpmRoot, 'node_modules', '.bin')
const localPnpm = path.join(localPnpmBinDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
const pnpmHomeFile = path.join(localToolsRoot, 'pnpm-home.txt')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
    ...opts,
  })
  return r.status === 0
}

function commandVersion(command) {
  const r = spawnSync(command, ['--version'], {
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: process.env,
  })
  return r.status === 0 ? String(r.stdout || '').trim() : null
}

function publishLocalPnpmPath() {
  mkdirSync(localToolsRoot, { recursive: true })
  writeFileSync(pnpmHomeFile, `${localPnpmBinDir}\n`, 'utf8')
  process.env.PATH = `${localPnpmBinDir}${path.delimiter}${process.env.PATH ?? ''}`
}

function clearLocalPnpmPathFile() {
  rmSync(pnpmHomeFile, { force: true })
}

// ---- 1. pnpm ------------------------------------------------------------
let pnpm = commandVersion('pnpm')
if (pnpm !== requiredPnpm) {
  const cachedLocal = existsSync(localPnpm) ? commandVersion(localPnpm) : null
  if (cachedLocal === requiredPnpm) {
    publishLocalPnpmPath()
    pnpm = commandVersion('pnpm')
    console.log(`[bootstrap] using cached repo-local pnpm ${requiredPnpm}`)
  }
}

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

  pnpm = commandVersion('pnpm')
  if (activated && pnpm === requiredPnpm) {
    clearLocalPnpmPathFile()
  } else {
    console.log(`[bootstrap] Corepack did not expose pnpm ${requiredPnpm}; installing an isolated repo-local copy...`)
    rmSync(localPnpmRoot, { recursive: true, force: true })
    mkdirSync(localPnpmRoot, { recursive: true })
    if (!run('npm', [
      'install',
      '--prefix', localPnpmRoot,
      '--no-package-lock',
      '--no-save',
      '--ignore-scripts',
      `pnpm@${requiredPnpm}`,
    ])) {
      console.error(`[bootstrap] ERROR: unable to provision repo-local pnpm ${requiredPnpm}.`)
      process.exit(1)
    }
    if (commandVersion(localPnpm) !== requiredPnpm) {
      console.error(`[bootstrap] ERROR: repo-local pnpm ${requiredPnpm} was installed but is not runnable.`)
      process.exit(1)
    }
    publishLocalPnpmPath()
    pnpm = commandVersion('pnpm')
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
