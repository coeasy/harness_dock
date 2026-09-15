import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  defaultDownloadCacheDir,
  ensureDownloadedRuntime as ensureNpmRuntime,
} from './fetch-runtime.ts'
import { inspectBundledRuntime, bundledRuntimeVersion } from './bundled.ts'
import { installRuntimeBundle, runtimeBundleKey, type RuntimeBundleSpec } from './runtime-bundle.ts'
import type { RuntimeProgressEvent } from './runtime.ts'

export { defaultDownloadCacheDir }

export async function ensureDownloadedRuntime(input: {
  origin: {
    dshVersion: string
    gitTag?: string
    gitCommit?: string
    npmPackage?: string
    npmTarball?: string
    npmIntegrity?: string
    runtimeBundles?: Record<string, RuntimeBundleSpec>
  }
  env: NodeJS.ProcessEnv
  cacheDir: string
  timeoutMs?: number
  onProgress?: (event: RuntimeProgressEvent) => void
}): Promise<{ dshBin: string; runtimeDir: string }> {
  const version = input.origin.dshVersion
  const key = runtimeBundleKey()
  const bundle = input.origin.runtimeBundles?.[key]

  if (!bundle) return ensureNpmRuntime(input)

  const runtimeDir = path.join(input.cacheDir, `runtime-${version}`)
  const layout = inspectBundledRuntime(runtimeDir, process.platform)
  if (
    layout &&
    bundledRuntimeVersion(runtimeDir) === version &&
    existsSync(path.join(runtimeDir, '.ready')) &&
    input.env.DSH_RUNTIME_CLEAN !== '1'
  ) {
    return { dshBin: layout.dshBin, runtimeDir }
  }

  await installRuntimeBundle({
    spec: bundle,
    version,
    gitTag: input.origin.gitTag,
    gitCommit: input.origin.gitCommit,
    runtimeDir,
    platform: process.platform,
    arch: process.arch,
    onProgress: input.onProgress,
  })
  const installed = inspectBundledRuntime(runtimeDir, process.platform)
  if (!installed) throw new Error(`installed runtime bundle is incomplete under ${runtimeDir}`)
  input.onProgress?.({ stage: 'done', root: runtimeDir })
  return { dshBin: installed.dshBin, runtimeDir }
}
