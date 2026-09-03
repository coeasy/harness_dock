#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectBundledRuntime, runtimeCacheDir } from './bundled.ts'
import {
  assertBundledPnpm,
  bundledPnpmEntry,
  bundledPnpmPackageDir,
  PNPM_BUNDLE_SHA256,
  PNPM_BUNDLE_VERSION,
  writeBundledPnpmShim,
} from './pnpm-tool.ts'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    arch: { type: 'string' },
    'runtime-dir': { type: 'string' },
  },
})

const platform = (values.platform ?? process.env.DSH_RUNTIME_PLATFORM ?? process.platform) as NodeJS.Platform
const arch = values.arch ?? process.env.DSH_RUNTIME_ARCH ?? process.arch
const runtimeDir = values['runtime-dir'] ?? process.env.DSH_RUNTIME_DIR
const dest = runtimeDir ? path.resolve(repoRoot, runtimeDir) : runtimeCacheDir(repoRoot)

if (!inspectBundledRuntime(dest, platform)) {
  throw new Error(`cannot embed pnpm: bundled Node+dsh runtime is incomplete under ${dest}`)
}

async function fetchPinnedPnpm(): Promise<Uint8Array> {
  const filename = `pnpm-${PNPM_BUNDLE_VERSION}.tgz`
  const urls = [
    ...(process.env.DSH_PNPM_MIRROR ? [process.env.DSH_PNPM_MIRROR] : []),
    `https://registry.npmjs.org/pnpm/-/${filename}`,
    `https://registry.npmmirror.com/pnpm/-/${filename}`,
  ]
  let lastError: unknown
  for (const raw of urls) {
    const url = raw.includes(filename) ? raw : `${raw.replace(/\/$/, '')}/${filename}`
    try {
      console.log(`[pnpm-runtime] downloading ${url}`)
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== PNPM_BUNDLE_SHA256) {
        throw new Error(`sha256 ${digest} != pinned ${PNPM_BUNDLE_SHA256}`)
      }
      return bytes
    } catch (error) {
      lastError = error
      console.warn(`[pnpm-runtime] source failed: ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError ?? new Error('all pnpm download sources failed')
}

let ready = false
try {
  await assertBundledPnpm(dest, platform)
  ready = true
} catch {
  ready = false
}

if (!ready) {
  const packageDir = bundledPnpmPackageDir(dest)
  const toolRoot = path.join(dest, 'tools', 'pnpm')
  const tarball = path.join(toolRoot, `pnpm-${PNPM_BUNDLE_VERSION}.tgz`)
  await rm(packageDir, { recursive: true, force: true })
  await mkdir(packageDir, { recursive: true })
  await mkdir(toolRoot, { recursive: true })

  const bytes = await fetchPinnedPnpm()
  await writeFile(tarball, bytes)
  await execFileAsync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], {
    windowsHide: true,
  })
  await rm(tarball, { force: true })
  await writeBundledPnpmShim(dest, platform)
}

await assertBundledPnpm(dest, platform)
const { stdout } = await execFileAsync(process.execPath, [bundledPnpmEntry(dest), '--version'], {
  // pnpm discovers the nearest packageManager field from cwd. The embedded
  // runtime deliberately pins a different pnpm major than HarnessDock.
  cwd: tmpdir(),
  windowsHide: true,
})
if (stdout.trim() !== PNPM_BUNDLE_VERSION) {
  throw new Error(`bundled pnpm smoke returned ${stdout.trim() || 'empty'}, expected ${PNPM_BUNDLE_VERSION}`)
}

const manifestPath = path.join(dest, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
manifest.pnpmEmbedded = true
manifest.pnpmVersion = PNPM_BUNDLE_VERSION
manifest.pnpmSha256 = PNPM_BUNDLE_SHA256
manifest.pluginManagementReady = true
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`[pnpm-runtime] bundled pnpm ${PNPM_BUNDLE_VERSION} ready for ${platform}/${arch}`)
