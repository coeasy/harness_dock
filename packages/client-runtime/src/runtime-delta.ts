import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Dirent } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { bundledRuntimeVersion, inspectBundledRuntime } from './bundled.ts'
import { assertBundledRuntimeIntegrity } from './integrity.ts'
import type { RuntimeProgressEvent } from './runtime.ts'

const execFileAsync = promisify(execFile)
const TREE_EXCLUDES = new Set(['.ready'])

export interface RuntimeDeltaSpec {
  url: string
  sha256: string
  size: number
}

export interface RuntimeDeltaManifest {
  schemaVersion: 1
  fromVersion: string
  toVersion: string
  platform: string
  arch: string
  fromTreeSha256: string
  toTreeSha256: string
  delete: string[]
}

export async function installRuntimeDelta(input: {
  spec: RuntimeDeltaSpec
  runtimeDir: string
  targetVersion: string
  platform?: NodeJS.Platform
  arch?: string
  onProgress?: (event: RuntimeProgressEvent) => void
}): Promise<void> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const nonce = `${process.pid}-${Date.now()}`
  const archive = `${input.runtimeDir}.delta-download-${nonce}.tar.gz`
  const deltaDir = `${input.runtimeDir}.delta-${nonce}`
  const stagingDir = `${input.runtimeDir}.delta-staging-${nonce}`
  const previousDir = `${input.runtimeDir}.previous`

  await mkdir(path.dirname(input.runtimeDir), { recursive: true })
  await rm(deltaDir, { recursive: true, force: true })
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(deltaDir, { recursive: true })

  try {
    await downloadVerifiedDelta({ ...input, archive, platform, arch })
    await assertSafeTarEntries(archive)
    await execFileAsync('tar', ['-xzf', archive, '-C', deltaDir], { windowsHide: true })
    await assertSafeSymlinks(deltaDir)

    const manifest = await readRuntimeDeltaManifest(path.join(deltaDir, 'delta-manifest.json'))
    if (manifest.toVersion !== input.targetVersion) {
      throw new Error(`runtime delta target ${manifest.toVersion} != expected ${input.targetVersion}`)
    }
    if (manifest.platform !== platform || manifest.arch !== arch) {
      throw new Error(
        `runtime delta target ${manifest.platform}/${manifest.arch} != host ${platform}/${arch}`,
      )
    }

    const installedVersion = bundledRuntimeVersion(input.runtimeDir)
    if (installedVersion !== manifest.fromVersion) {
      throw new Error(
        `runtime delta base version ${installedVersion ?? 'unknown'} != required ${manifest.fromVersion}`,
      )
    }
    const baseDigest = await runtimeTreeDigest(input.runtimeDir)
    if (baseDigest !== manifest.fromTreeSha256) {
      throw new Error(
        `runtime delta base tree ${baseDigest} != required ${manifest.fromTreeSha256}`,
      )
    }

    await cp(input.runtimeDir, stagingDir, {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    await applyRuntimeOverlay({
      stagingDir,
      overlayDir: path.join(deltaDir, 'overlay'),
      deletePaths: manifest.delete,
    })
    await assertSafeSymlinks(stagingDir)

    const candidateDigest = await runtimeTreeDigest(stagingDir)
    if (candidateDigest !== manifest.toTreeSha256) {
      throw new Error(
        `runtime delta result tree ${candidateDigest} != expected ${manifest.toTreeSha256}`,
      )
    }
    const candidateVersion = bundledRuntimeVersion(stagingDir)
    if (candidateVersion !== input.targetVersion) {
      throw new Error(
        `runtime delta result version ${candidateVersion ?? 'unknown'} != expected ${input.targetVersion}`,
      )
    }
    if (!inspectBundledRuntime(stagingDir, platform)) {
      throw new Error(`runtime delta result layout is incomplete under ${stagingDir}`)
    }
    await assertBundledRuntimeIntegrity(stagingDir, platform, arch)
    await writeFile(path.join(stagingDir, '.ready'), `${new Date().toISOString()}\n`, 'utf8')

    await swapRuntimeDirectories(input.runtimeDir, stagingDir, previousDir)
    input.onProgress?.({ stage: 'done', root: input.runtimeDir })
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(deltaDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(archive, { force: true }).catch(() => undefined)
  }
}

export async function runtimeTreeDigest(runtimeDir: string): Promise<string> {
  const records: string[] = []
  await collectTreeRecords(runtimeDir, '', records)
  records.sort()
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

export async function applyRuntimeOverlay(input: {
  stagingDir: string
  overlayDir: string
  deletePaths: string[]
}): Promise<void> {
  const deletions = [...new Set(input.deletePaths.map(safeRelativePath))]
    .sort((left, right) => right.length - left.length)
  for (const relative of deletions) {
    await rm(resolveInside(input.stagingDir, relative), { recursive: true, force: true })
  }

  let overlayEntries: Dirent<string>[] = []
  try {
    overlayEntries = await readdir(input.overlayDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return
    throw error
  }
  for (const entry of overlayEntries) {
    const relative = safeRelativePath(entry.name)
    await cp(
      path.join(input.overlayDir, entry.name),
      resolveInside(input.stagingDir, relative),
      {
        recursive: true,
        force: true,
        dereference: false,
        verbatimSymlinks: true,
      },
    )
  }
}

export async function readRuntimeDeltaManifest(file: string): Promise<RuntimeDeltaManifest> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!value || typeof value !== 'object') throw new Error('runtime delta manifest must be an object')
  const manifest = value as Partial<RuntimeDeltaManifest>
  if (manifest.schemaVersion !== 1) throw new Error('unsupported runtime delta manifest schema')
  for (const key of [
    'fromVersion',
    'toVersion',
    'platform',
    'arch',
    'fromTreeSha256',
    'toTreeSha256',
  ] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key]?.length === 0) {
      throw new Error(`runtime delta manifest is missing ${key}`)
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.fromTreeSha256 ?? '')) {
    throw new Error('runtime delta manifest has invalid fromTreeSha256')
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.toTreeSha256 ?? '')) {
    throw new Error('runtime delta manifest has invalid toTreeSha256')
  }
  if (!Array.isArray(manifest.delete) || manifest.delete.some((item) => typeof item !== 'string')) {
    throw new Error('runtime delta manifest delete must be a string array')
  }
  for (const item of manifest.delete) safeRelativePath(item)
  return manifest as RuntimeDeltaManifest
}

async function downloadVerifiedDelta(input: {
  spec: RuntimeDeltaSpec
  archive: string
  platform: NodeJS.Platform
  arch: string
  onProgress?: (event: RuntimeProgressEvent) => void
}): Promise<void> {
  const response = await fetch(input.spec.url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok || !response.body) {
    throw new Error(`runtime delta download failed: HTTP ${response.status} ${input.spec.url}`)
  }
  const reader = response.body.getReader()
  const stream = createWriteStream(input.archive)
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
      input.onProgress?.({
        stage: 'fetch',
        name: `runtime-delta-${input.platform}-${input.arch}`,
        done: Math.min(bytes, input.spec.size),
        total: input.spec.size,
        bytes,
        percent: Math.min(100, Math.round((bytes / input.spec.size) * 100)),
      })
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve())
      stream.once('error', reject)
    })
  }
  if (bytes !== input.spec.size) {
    throw new Error(`runtime delta size ${bytes} != expected ${input.spec.size}`)
  }
  const actual = await sha256File(input.archive)
  if (actual.toLowerCase() !== input.spec.sha256.toLowerCase()) {
    throw new Error(`runtime delta sha256 ${actual} != expected ${input.spec.sha256}`)
  }
}

async function assertSafeTarEntries(archive: string): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) throw new Error('runtime delta archive is empty')
  for (const raw of entries) {
    const entry = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (entry === 'delta-manifest.json' || entry === 'overlay') continue
    if (!entry.startsWith('overlay/')) {
      throw new Error(`runtime delta archive contains unexpected entry: ${raw}`)
    }
    safeRelativePath(entry.slice('overlay/'.length))
  }
}

async function assertSafeSymlinks(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const details = await lstat(absolute)
      if (details.isSymbolicLink()) {
        const target = await readlink(absolute)
        if (path.isAbsolute(target)) throw new Error(`runtime delta contains absolute symlink: ${absolute}`)
        const resolvedTarget = path.resolve(path.dirname(absolute), target)
        if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`runtime delta symlink escapes runtime root: ${absolute} -> ${target}`)
        }
      } else if (details.isDirectory()) {
        await visit(absolute)
      }
    }
  }
  await visit(root)
}

async function collectTreeRecords(root: string, relative: string, records: string[]): Promise<void> {
  const dir = relative ? resolveInside(root, relative) : root
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!relative && TREE_EXCLUDES.has(entry.name)) continue
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    const normalized = safeRelativePath(childRelative)
    const absolute = resolveInside(root, normalized)
    const details = await lstat(absolute)
    if (details.isDirectory()) {
      await collectTreeRecords(root, normalized, records)
    } else if (details.isSymbolicLink()) {
      records.push(`L\t${normalized}\t${await readlink(absolute)}`)
    } else if (details.isFile()) {
      records.push(`F\t${normalized}\t${details.size}\t${await sha256File(absolute)}`)
    } else {
      throw new Error(`unsupported runtime tree entry: ${normalized}`)
    }
  }
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe runtime delta path: ${value}`)
  }
  return normalized
}

function resolveInside(root: string, relative: string): string {
  const safe = safeRelativePath(relative)
  const rootResolved = path.resolve(root)
  const resolved = path.resolve(root, ...safe.split('/'))
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`runtime delta path escapes root: ${relative}`)
  }
  return resolved
}

async function swapRuntimeDirectories(runtimeDir: string, stagingDir: string, previousDir: string): Promise<void> {
  await rm(previousDir, { recursive: true, force: true })
  let hadPrevious = false
  try {
    await stat(runtimeDir)
    hadPrevious = true
  } catch {
    hadPrevious = false
  }
  if (hadPrevious) await rename(runtimeDir, previousDir)
  try {
    await rename(stagingDir, runtimeDir)
  } catch (error) {
    if (hadPrevious) await rename(previousDir, runtimeDir).catch(() => undefined)
    throw error
  }
  if (hadPrevious) await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
