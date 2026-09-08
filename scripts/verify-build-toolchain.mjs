#!/usr/bin/env node
/**
 * Verify that the one-click wrapper activated the build tools it intended to.
 *
 * Portable Node is a build-time tool only. The installed HarnessDock client
 * continues to use its separately sealed Node+dsh Runtime.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isPathWithin(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function canonicalPath(value) {
  return typeof realpathSync.native === 'function' ? realpathSync.native(value) : realpathSync(value)
}

function fail(message) {
  console.error(`[toolchain] ERROR: ${message}`)
  process.exit(1)
}

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${name} requires a value`)
  return value
}

function commandVersion(command) {
  let result
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    result = spawnSync(comspec, ['/d', '/s', '/c', `""${command}" --version"`], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } else {
    result = spawnSync(command, ['--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    })
  }
  if (result.status !== 0) return null
  return String(result.stdout || '').trim()
}

function verifyPortableNode(nodeHomeInput, npmCommandInput) {
  let nodeHome
  let activeNode
  let activeNpm
  try {
    nodeHome = canonicalPath(nodeHomeInput)
    activeNode = canonicalPath(process.execPath)
    activeNpm = canonicalPath(npmCommandInput)
  } catch (error) {
    fail(`unable to canonicalize portable Node toolchain paths: ${error.message}`)
  }

  if (!isPathWithin(nodeHome, activeNode)) {
    fail(`active Node escaped portable home: ${activeNode} (expected within ${nodeHome})`)
  }
  if (!isPathWithin(nodeHome, activeNpm)) {
    fail(`active npm escaped portable home: ${activeNpm} (expected within ${nodeHome})`)
  }

  const versions = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'versions.json'), 'utf8'))
  const expectedNodeVersion = String(versions.node || '')
  if (!expectedNodeVersion || process.versions.node !== expectedNodeVersion) {
    fail(`portable Node version mismatch: expected ${expectedNodeVersion || 'missing pin'}, got ${process.versions.node}`)
  }

  const npmVersion = commandVersion(npmCommandInput)
  if (!npmVersion) fail(`portable npm is not runnable: ${npmCommandInput}`)

  console.log(`[toolchain] portable Node verified: v${process.versions.node} (${activeNode})`)
  console.log(`[toolchain] portable npm verified: ${npmVersion} (${activeNpm})`)
}

function verifyLocalPnpm(pnpmBinInput, pnpmCommandInput) {
  let pnpmBin
  let localPnpmRoot
  let activePnpm
  try {
    pnpmBin = canonicalPath(pnpmBinInput)
    localPnpmRoot = canonicalPath(path.resolve(pnpmBin, '..', '..'))
    activePnpm = canonicalPath(pnpmCommandInput)
  } catch (error) {
    fail(`unable to canonicalize repository-local pnpm paths: ${error.message}`)
  }

  if (!isPathWithin(localPnpmRoot, activePnpm)) {
    fail(`active pnpm escaped repository-local root: ${activePnpm} (expected within ${localPnpmRoot})`)
  }

  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const match = /^pnpm@([^\s]+)$/.exec(String(rootPackage.packageManager || ''))
  if (!match) fail('package.json packageManager does not contain an exact pnpm pin')

  const expectedPnpmVersion = match[1]
  const actualPnpmVersion = commandVersion(pnpmCommandInput)
  if (actualPnpmVersion !== expectedPnpmVersion) {
    fail(`repository-local pnpm version mismatch: expected ${expectedPnpmVersion}, got ${actualPnpmVersion || 'unavailable'}`)
  }

  console.log(`[toolchain] repository-local pnpm verified: ${actualPnpmVersion} (${activePnpm})`)
}

function main() {
  const nodeHome = readOption('--node-home')
  const npmCommand = readOption('--npm-command')
  const pnpmBin = readOption('--pnpm-bin')
  const pnpmCommand = readOption('--pnpm-command')

  if ((nodeHome && !npmCommand) || (!nodeHome && npmCommand)) {
    fail('--node-home and --npm-command must be provided together')
  }
  if ((pnpmBin && !pnpmCommand) || (!pnpmBin && pnpmCommand)) {
    fail('--pnpm-bin and --pnpm-command must be provided together')
  }
  if (!nodeHome && !pnpmBin) fail('no toolchain identity was requested')

  if (nodeHome) verifyPortableNode(nodeHome, npmCommand)
  if (pnpmBin) verifyLocalPnpm(pnpmBin, pnpmCommand)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main()
}
