#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectBundledRuntime, runtimeCacheDir } from './bundled.ts'
import { assertBundledRuntimeIntegrity } from './integrity.ts'
import { pruneBundledNodeDistribution } from './node-runtime-prune.ts'

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
  throw new Error(`cannot prune Node distribution: bundled Node+dsh runtime is incomplete under ${dest}`)
}

const { removedBytes, removedCount } = await pruneBundledNodeDistribution(dest, platform)
await assertBundledRuntimeIntegrity(dest, platform, arch)

const manifestPath = path.join(dest, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
const priorBytes = Number(manifest.nodeDistributionPrunedBytes) || 0
const priorCount = Number(manifest.nodeDistributionPrunedCount) || 0
manifest.nodeDistributionPruned = true
manifest.nodeDistributionPrunedBytes = priorBytes + removedBytes
manifest.nodeDistributionPrunedCount = priorCount + removedCount
manifest.runtimeEmbedded = true
manifest.firstLaunchRuntimeDownloadRequired = false
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(
  `[node-prune] embedded runtime verified: ${dest}; removed ${(removedBytes / 1024 / 1024).toFixed(1)} MB this pass`,
)
