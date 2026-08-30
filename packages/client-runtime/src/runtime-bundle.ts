import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { inspectBundledRuntime, bundledRuntimeVersion } from './bundled.ts'
import { assertBundledRuntimeIntegrity } from './integrity.ts'
import type { RuntimeProgressEvent } from './runtime.ts'

const execFileAsync = promisify(execFile)

export interface RuntimeBundleSpec {
  url: string
  /** Optional immutable archive digest from release-manifest.json. */
  sha256?: string
  /** Optional archive byte size from release-manifest.json. */
  size?: number
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
  const nonce = `${process.pid}-${Date.now()}`
  const archive = `${input.runtimeDir}.download-${nonce}.tar.gz`
  const stagingDir = `${input.runtimeDir}.staging-${nonce}`
  const previousDir = `${input.runtimeDir}.previous`

  await mkdir(path.dirname(input.runtimeDir), { recursive: true })
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  try {
    const response = await fetch(input.spec.url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) {
      throw new Error(`runtime bundle download failed: HTTP ${response.status} ${input.spec.url}`)
    }

    const responseSize = Number(response.headers.get('content-length') ?? 0)
    const expectedSize = input.spec.size && input.spec.size > 0 ? input.spec.size : responseSize
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
        const percent = expectedSize > 0 ? Math.min(100, Math.round((bytes / expectedSize) * 100)) : undefined
        input.onProgress?.({
          stage: 'fetch',
          name: `runtime-${platform}-${arch}`,
          done: expectedSize > 0 ? Math.min(bytes, expectedSize) : bytes,
          total: expectedSize > 0 ? expectedSize : Math.max(bytes, 1),
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

    if (input.spec.size !== undefined && bytes !== input.spec.size) {
      throw new Error(`runtime bundle size ${bytes} != expected ${input.spec.size}`)
    }
    if (input.spec.sha256) {
      const actualSha256 = await sha256File(archive)
      if (actualSha256.toLowerCase() !== input.spec.sha256.toLowerCase()) {
        throw new Error(`runtime bundle sha256 ${actualSha256} != expected ${input.spec.sha256}`)
      }
    }

    await execFileAsync('tar', ['-xzf', archive, '-C', stagingDir], { windowsHide: true })
    await verifyRuntimeDirectory({
      runtimeDir: stagingDir,
      version: input.version,
      gitTag: input.gitTag,
      gitCommit: input.gitCommit,
      platform,
      arch,
    })
    await writeFile(path.join(stagingDir, '.ready'), `${new Date().toISOString()}\n`, 'utf8')

    // Commit only after the candidate is fully verified. The previous runtime
    // remains untouched throughout download/extract/verification, so an update
    // failure cannot brick the next launch.
    await swapRuntimeDirectories(input.runtimeDir, stagingDir, previousDir)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(archive, { force: true }).catch(() => undefined)
  }
}

async function verifyRuntimeDirectory(input: {
  runtimeDir: string
  version: string
  gitTag?: string
  gitCommit?: string
  platform: NodeJS.Platform
  arch: string
}): Promise<void> {
  const layout = inspectBundledRuntime(input.runtimeDir, input.platform)
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
  if (manifest.platform && manifest.platform !== input.platform) {
    throw new Error(`runtime bundle platform ${manifest.platform} != host ${input.platform}`)
  }
  if (manifest.arch && manifest.arch !== input.arch) {
    throw new Error(`runtime bundle arch ${manifest.arch} != host ${input.arch}`)
  }

  await assertBundledRuntimeIntegrity(input.runtimeDir, input.platform, input.arch)
}

async function swapRuntimeDirectories(runtimeDir: string, stagingDir: string, previousDir: string): Promise<void> {
  await rm(previousDir, { recursive: true, force: true })
  const hadPrevious = existsSync(runtimeDir)
  if (hadPrevious) await rename(runtimeDir, previousDir)

  try {
    await rename(stagingDir, runtimeDir)
  } catch (error) {
    if (hadPrevious && !existsSync(runtimeDir) && existsSync(previousDir)) {
      await rename(previousDir, runtimeDir).catch(() => undefined)
    }
    throw error
  }

  // Cleanup is intentionally best-effort after the new verified runtime has
  // committed. A leftover previous directory is safe and can be pruned later.
  if (hadPrevious) await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
}

async function sha256File(file: string): Promise<string> {
  const expectedSize = (await stat(file)).size
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    hash.update(buffer)
  }
  if (bytes !== expectedSize) throw new Error(`short read while hashing runtime bundle: ${bytes}/${expectedSize}`)
  return hash.digest('hex')
}
