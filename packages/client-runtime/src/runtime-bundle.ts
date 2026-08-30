import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { inspectBundledRuntime, bundledRuntimeVersion } from './bundled.ts'
import { assertBundledRuntimeIntegrity } from './integrity.ts'
import type { RuntimeProgressEvent } from './runtime.ts'

const execFileAsync = promisify(execFile)

export interface RuntimeBundleSpec {
  url: string
}

export function runtimeBundleKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`
}

export async function installRuntimeBundle(input: {
  spec: RuntimeBundleSpec
  version: string
  gitTag?: string
  gitCommit?: string
  runtimeDir: string
  platform?: NodeJS.Platform
  arch?: string
  onProgress?: (event: RuntimeProgressEvent) => void
}): Promise<void> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const archive = `${input.runtimeDir}.tar.gz`

  await rm(input.runtimeDir, { recursive: true, force: true })
  await mkdir(path.dirname(input.runtimeDir), { recursive: true })
  await mkdir(input.runtimeDir, { recursive: true })

  try {
    const response = await fetch(input.spec.url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) {
      throw new Error(`runtime bundle download failed: HTTP ${response.status} ${input.spec.url}`)
    }

    const total = Number(response.headers.get('content-length') ?? 0)
    const reader = response.body.getReader()
    const stream = createWriteStream(archive)
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        bytes += value.byteLength
        if (!stream.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            stream.once('drain', resolve)
            stream.once('error', reject)
          })
        }
        const percent = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : undefined
        input.onProgress?.({
          stage: 'fetch',
          name: `runtime-${platform}-${arch}`,
          done: total > 0 ? Math.min(bytes, total) : bytes,
          total: total > 0 ? total : Math.max(bytes, 1),
          bytes,
          percent,
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve())
        stream.once('error', reject)
      })
    }

    await execFileAsync('tar', ['-xzf', archive, '-C', input.runtimeDir], { windowsHide: true })

    const layout = inspectBundledRuntime(input.runtimeDir, platform)
    if (!layout) {
      throw new Error(`runtime bundle layout is incomplete under ${input.runtimeDir}`)
    }
    const actualVersion = bundledRuntimeVersion(input.runtimeDir)
    if (actualVersion !== input.version) {
      throw new Error(`runtime bundle dsh version ${actualVersion ?? 'unknown'} != pinned ${input.version}`)
    }

    const manifest = JSON.parse(
      await readFile(path.join(input.runtimeDir, 'manifest.json'), 'utf8'),
    ) as { gitTag?: string; gitCommit?: string; platform?: string; arch?: string }
    if (input.gitTag && manifest.gitTag !== input.gitTag) {
      throw new Error(`runtime bundle git tag ${manifest.gitTag ?? 'unknown'} != pinned ${input.gitTag}`)
    }
    if (input.gitCommit && manifest.gitCommit !== input.gitCommit) {
      throw new Error(
        `runtime bundle git commit ${manifest.gitCommit ?? 'unknown'} != pinned ${input.gitCommit}`,
      )
    }
    if (manifest.platform && manifest.platform !== platform) {
      throw new Error(`runtime bundle platform ${manifest.platform} != host ${platform}`)
    }
    if (manifest.arch && manifest.arch !== arch) {
      throw new Error(`runtime bundle arch ${manifest.arch} != host ${arch}`)
    }

    await assertBundledRuntimeIntegrity(input.runtimeDir, platform, arch)
    await writeFile(path.join(input.runtimeDir, '.ready'), `${new Date().toISOString()}\n`, 'utf8')
  } catch (error) {
    await rm(input.runtimeDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(archive, { force: true }).catch(() => undefined)
  }
}
