#!/usr/bin/env node
/**
 * Prepare the sealed Harness Runtime required by a local Tauri build.
 *
 * Fast path:
 *   reuse an already-valid resources/dsh-runtime or download the exact runtime
 *   bundle published by HarnessDock and verify its GitHub SHA-256 digest.
 *
 * Fallback:
 *   clone the exact pinned deepseek-harness tag/commit, build the official
 *   profile, pack the official dsh/vendor closure, and feed those packs into
 *   the same @dsh/client-runtime bundler used by release CI.
 *
 * This script is build-time only. Installed HarnessDock never checks or uses
 * the developer machine's system Node/pnpm to start Harness Web.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = JSON.parse(await readFile(path.join(repoRoot, 'packages/docs-sync/origin.json'), 'utf8'))
const product = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const runtimeDir = path.join(repoRoot, 'apps/tauri/src-tauri/resources/dsh-runtime')
const cacheRoot = path.join(repoRoot, '.local-cache')
const upstreamRoot = path.join(cacheRoot, 'deepseek-harness', origin.gitTag)
const packedRoot = path.join(upstreamRoot, 'dist')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git'
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar'
const RUNTIME_SCHEMA_VERSION = 1
const RUNTIME_LAYOUT_VERSION = 6
const RUNTIME_IMAGE_IDENTITY_ALGORITHM = 'sha256-v1'

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    'source-only': { type: 'boolean', default: false },
    'no-source-fallback': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/prepare-local-runtime.mjs [options]

Options:
      --force               rebuild/redownload even if the local runtime is valid
      --source-only         skip release bundle download and build from pinned upstream source
      --no-source-fallback  fail instead of building from source when a release bundle is unavailable
  -h, --help                show this help

Supported local desktop targets: win32-x64, linux-x64, darwin-x64, darwin-arm64.`)
  process.exit(0)
}

const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
const key = `${process.platform}-${arch}`
const supported = new Set(['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'])
if (!supported.has(key)) {
  throw new Error(`unsupported local desktop runtime target: ${key}`)
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: process.platform === 'win32',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.status !== 0) {
    const suffix = options.capture ? `\n${result.stderr ?? ''}` : ''
    throw new Error(`${command} failed with exit code ${result.status}${suffix}`)
  }
  return options.capture ? String(result.stdout ?? '').trim() : ''
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

async function readRuntimeManifest(root = runtimeDir) {
  try {
    return JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function manifestMismatchReasons(manifest) {
  if (!manifest || typeof manifest !== 'object') return ['manifest missing or invalid']

  const expected = {
    platform: process.platform,
    arch,
    dshVersion: origin.dshVersion,
    gitTag: origin.gitTag,
    gitCommit: origin.gitCommit,
    dshGitTag: origin.gitTag,
    dshGitCommit: origin.gitCommit,
    clientVersion: product.version,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runtimeLayoutVersion: RUNTIME_LAYOUT_VERSION,
    imageIdentityAlgorithm: RUNTIME_IMAGE_IDENTITY_ALGORITHM,
    runtimeEmbedded: true,
    firstLaunchRuntimeDownloadRequired: false,
  }
  const reasons = []
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (manifest[field] !== expectedValue) {
      reasons.push(`${field}=${String(manifest[field] ?? 'missing')} expected ${String(expectedValue)}`)
    }
  }

  if (typeof manifest.imageIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(manifest.imageIdentity)) {
    reasons.push('imageIdentity missing or malformed')
  }
  if (!Number.isInteger(Number(manifest.contentFileCount)) || Number(manifest.contentFileCount) <= 0) {
    reasons.push('contentFileCount missing or invalid')
  }
  if (!Number.isFinite(Number(manifest.contentBytes)) || Number(manifest.contentBytes) <= 0) {
    reasons.push('contentBytes missing or invalid')
  }
  return reasons
}

function manifestMatches(manifest) {
  return manifestMismatchReasons(manifest).length === 0
}

function manifestMismatchSummary(manifest) {
  return manifestMismatchReasons(manifest).join('; ')
}

async function hasPackedTarballs() {
  for (const family of ['dsh', 'vendor']) {
    const dir = path.join(packedRoot, family)
    try {
      const entries = await readdir(dir)
      if (!entries.some((name) => name.endsWith('.tgz'))) return false
    } catch {
      return false
    }
  }
  return true
}

function releaseAssetName() {
  return `HarnessDock-runtime-${origin.dshVersion}-${key}.tar.gz`
}

function releaseBundleCandidates() {
  const name = releaseAssetName()
  const candidates = [
    `https://github.com/coeasy/harness_dock/releases/download/v${product.version}/${name}`,
    origin.runtimeBundles?.[key]?.url,
  ].filter(Boolean)
  return [...new Set(candidates)]
}

function parseReleaseDownloadUrl(raw) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^?#]+)$/.exec(raw)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    tag: decodeURIComponent(match[3]),
    name: decodeURIComponent(match[4]),
  }
}

async function fetchWithTimeout(url, timeout = 30_000) {
  return fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'HarnessDock-local-build' },
    signal: AbortSignal.timeout(timeout),
  })
}

async function expectedReleaseDigest(url) {
  const parsed = parseReleaseDownloadUrl(url)
  if (!parsed) return null

  try {
    const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`
    const response = await fetchWithTimeout(api, 15_000)
    if (response.ok) {
      const release = await response.json()
      const asset = Array.isArray(release.assets)
        ? release.assets.find((entry) => entry?.name === parsed.name)
        : null
      if (typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:')) {
        return asset.digest.slice('sha256:'.length).toLowerCase()
      }
    }
  } catch {
    // Fall through to SHA256SUMS.
  }

  try {
    const sumsUrl = url.slice(0, url.lastIndexOf('/') + 1) + 'SHA256SUMS'
    const response = await fetchWithTimeout(sumsUrl, 15_000)
    if (!response.ok) return null
    const text = await response.text()
    for (const line of text.split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim())
      if (match && path.basename(match[2]) === parsed.name) return match[1].toLowerCase()
    }
  } catch {
    // No checksum source.
  }
  return null
}

async function sha256File(file) {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function downloadFile(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true })
  const partial = `${destination}.partial-${process.pid}`
  await rm(partial, { force: true })
  const response = await fetchWithTimeout(url, 180_000)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  await rm(destination, { force: true })
  await rename(partial, destination)
}

async function installReleaseBundle(url) {
  if (!commandAvailable(tarCommand, ['--version'])) {
    throw new Error('tar is required to unpack the sealed runtime bundle')
  }

  const parsed = parseReleaseDownloadUrl(url)
  const fileName = parsed?.name ?? path.basename(new URL(url).pathname)
  const archive = path.join(cacheRoot, 'runtime-bundles', fileName)
  const expectedDigest = await expectedReleaseDigest(url)
  if (!expectedDigest) {
    throw new Error(`no trusted SHA-256 digest is published for ${url}`)
  }

  let actualDigest = null
  if (existsSync(archive)) actualDigest = await sha256File(archive)
  if (actualDigest !== expectedDigest) {
    console.log(`[runtime] downloading verified bundle: ${url}`)
    await downloadFile(url, archive)
    actualDigest = await sha256File(archive)
  }
  if (actualDigest !== expectedDigest) {
    throw new Error(`runtime bundle SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`)
  }

  const temp = `${runtimeDir}.local-tmp-${process.pid}`
  await rm(temp, { recursive: true, force: true })
  await mkdir(temp, { recursive: true })
  try {
    run(tarCommand, ['-xzf', archive, '-C', temp])
    const manifest = await readRuntimeManifest(temp)
    if (!manifestMatches(manifest)) {
      throw new Error(`downloaded runtime manifest mismatch: ${manifestMismatchSummary(manifest)}`)
    }
    await rm(runtimeDir, { recursive: true, force: true })
    await rename(temp, runtimeDir)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  console.log(`[runtime] verified exact sealed runtime installed: ${runtimeDir}`)
}

async function ensurePinnedUpstreamCheckout() {
  if (!commandAvailable(gitCommand, ['--version'])) {
    throw new Error('git is required for the pinned upstream source fallback')
  }

  let checkoutValid = false
  if (existsSync(path.join(upstreamRoot, '.git'))) {
    try {
      checkoutValid = run(gitCommand, ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { capture: true }) === origin.gitCommit
    } catch {
      checkoutValid = false
    }
  }

  if (!checkoutValid) {
    await rm(upstreamRoot, { recursive: true, force: true })
    await mkdir(path.dirname(upstreamRoot), { recursive: true })
    run(gitCommand, [
      'clone',
      '--depth', '1',
      '--branch', origin.gitTag,
      'https://github.com/deepseek-ai/deepseek-harness.git',
      upstreamRoot,
    ])
  }

  const actual = run(gitCommand, ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { capture: true })
  if (actual !== origin.gitCommit) {
    throw new Error(`pinned upstream mismatch: expected ${origin.gitCommit}, got ${actual}`)
  }
}

async function patchPinnedUpstreamWindowsCommandLaunchers() {
  if (process.platform !== 'win32') return

  // The pinned release helper launches package-manager shims with Node's
  // shell-free child_process APIs. Windows cannot execute .cmd shims by their
  // extensionless names in that mode, so the source fallback fails even after
  // this build has provisioned the exact repository-local pnpm.
  const processPath = path.join(upstreamRoot, 'scripts/release/process.ts')
  const source = await readFile(processPath, 'utf8')
  const marker = 'export interface RunOptions {'
  if (source.includes('function useShellForPackageManager(command: string): boolean')) return
  const helper = `function useShellForPackageManager(command: string): boolean {
  return process.platform === 'win32' && ['npm', 'npx', 'pnpm'].includes(command)
}

`
  if (!source.includes(marker)) throw new Error(`unexpected pinned release process helper: ${processPath}`)
  const patched = source
    .replace(marker, `${helper}${marker}`)
    .replace(
      "spawnSync(command, [...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' })",
      "spawnSync(command, [...args], { cwd: options.cwd, env: options.env, encoding: 'utf8', shell: useShellForPackageManager(command) })",
    )
    .replace(
      "encoding: 'utf8',\n    stdio: ['inherit', 'pipe', 'pipe'],",
      "encoding: 'utf8',\n    shell: useShellForPackageManager(command),\n    stdio: ['inherit', 'pipe', 'pipe'],",
    )
    .replace(
      "stdio: 'inherit' })",
      "stdio: 'inherit', shell: useShellForPackageManager(command) })",
    )
  if (patched === source) return
  await writeFile(processPath, patched, 'utf8')
  console.log('[runtime] applied Windows package-manager launcher compatibility to pinned release helpers')
}

async function buildOfficialPackedRuntime() {
  await ensurePinnedUpstreamCheckout()
  await patchPinnedUpstreamWindowsCommandLaunchers()
  if (!commandAvailable(npxCommand, ['--version'])) {
    throw new Error('npx is required for the pinned upstream source fallback')
  }

  if (!values.force && (await hasPackedTarballs())) {
    console.log(`[runtime] reusing cached official upstream packs: ${packedRoot}`)
    return
  }

  run(npxCommand, ['--yes', 'pnpm@11.7.0', 'install', '--frozen-lockfile'], { cwd: upstreamRoot })
  run(npxCommand, ['--yes', 'pnpm@11.7.0', 'build:official'], { cwd: upstreamRoot })
  await rm(packedRoot, { recursive: true, force: true })
  run(npxCommand, ['--yes', 'pnpm@11.7.0', 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'vendor', '--out', 'dist/vendor'], { cwd: upstreamRoot })
  run(npxCommand, ['--yes', 'pnpm@11.7.0', 'exec', 'tsx', 'scripts/release/pack.ts', '--family', 'dsh', '--out', 'dist/dsh'], { cwd: upstreamRoot })
  run(npxCommand, [
    '--yes', 'pnpm@11.7.0', 'exec', 'tsx',
    'scripts/release/verify-packed-install.ts',
    '--family', 'dsh', '--from', 'dist/dsh', '--from', 'dist/vendor',
  ], {
    cwd: upstreamRoot,
    // npm's strict peer graph builder crashes on this large all-local-tarball
    // consumer graph (Cannot read properties of null, reading edgesOut).
    // Legacy peer handling still installs the exact tarballs and lets the
    // verifier exercise the installed entrypoint without that npm bug.
    env: {
      npm_config_legacy_peer_deps: 'true',
      npm_config_ignore_scripts: 'true',
    },
  })

  if (!(await hasPackedTarballs())) throw new Error('official upstream pack step produced no dsh/vendor tarballs')
}

async function buildRuntimeFromSource() {
  if (!commandAvailable(pnpmCommand, ['--version'])) {
    throw new Error('pnpm is required to compose the local sealed runtime')
  }
  if (!commandAvailable(tarCommand, ['--version'])) {
    throw new Error('tar is required to compose the local sealed runtime')
  }

  console.log(`[runtime] building exact pinned Runtime from source: ${origin.gitTag} @ ${origin.gitCommit}`)
  await buildOfficialPackedRuntime()
  await rm(runtimeDir, { recursive: true, force: true })
  run(pnpmCommand, ['--filter', '@dsh/client-runtime', 'bundle-runtime'], {
    env: {
      DSH_PACKED_RUNTIME_DIR: packedRoot,
      DSH_RUNTIME_PLATFORM: process.platform,
      DSH_RUNTIME_ARCH: arch,
      DSH_RUNTIME_DIR: 'apps/tauri/src-tauri/resources/dsh-runtime',
      HARNESSDOCK_BUILD_COMMIT: 'local',
    },
  })

  const manifest = await readRuntimeManifest()
  if (!manifestMatches(manifest)) {
    throw new Error(`source-built runtime manifest mismatch: ${manifestMismatchSummary(manifest)}`)
  }
  console.log(`[runtime] source-built exact sealed runtime ready: ${runtimeDir}`)
}

const existingManifest = await readRuntimeManifest()
if (!values.force && manifestMatches(existingManifest)) {
  console.log(
    `[runtime] existing sealed runtime exactly matches ${key}, dsh ${origin.dshVersion} @ ${origin.gitCommit}; reusing it`,
  )
  process.exit(0)
}
if (!values.force && existingManifest) {
  console.log(`[runtime] cached runtime is stale or incompatible; refreshing: ${manifestMismatchSummary(existingManifest)}`)
}

let bundleError = null
if (!values['source-only']) {
  for (const url of releaseBundleCandidates()) {
    try {
      await installReleaseBundle(url)
      process.exit(0)
    } catch (error) {
      bundleError = error
      console.warn(`[runtime] published bundle unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

if (values['no-source-fallback']) {
  throw bundleError ?? new Error(`no published runtime bundle is available for ${key}`)
}

await buildRuntimeFromSource()

