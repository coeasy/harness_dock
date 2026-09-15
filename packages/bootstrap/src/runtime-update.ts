import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

export interface RuntimeReleaseFile {
  path: string
  sha256: string
  size: number
  url: string
  executable?: boolean
}

export interface RuntimeReleaseManifest {
  schemaVersion: 2
  runtime: 'dsh'
  version: string
  platform: NodeJS.Platform
  arch: string
  protocolVersion: number
  files: readonly RuntimeReleaseFile[]
}

export interface NormalizedRuntimeReleaseManifest extends RuntimeReleaseManifest {
  files: readonly RuntimeReleaseFile[]
}

export interface RuntimeInstallMetadata {
  schemaVersion: 1
  manifestDigest: string
  manifest: NormalizedRuntimeReleaseManifest
  installedAt: string
}

export interface RuntimeActivationState {
  schemaVersion: 1
  current?: {
    version: string
    manifestDigest: string
  }
  previous?: {
    version: string
    manifestDigest: string
  }
  updatedAt: string
}

export interface RuntimePrepareResult {
  version: string
  directory: string
  manifestDigest: string
  reusedFiles: number
  downloadedFiles: number
  reusedBytes: number
  downloadedBytes: number
}

export type RuntimeArtifactFetcher = (
  file: RuntimeReleaseFile,
  destination: string,
) => Promise<void>

export interface RuntimeUpdateManagerOptions {
  root: string
  fetchFile: RuntimeArtifactFetcher
  platform?: NodeJS.Platform
  arch?: string
  now?: () => Date
}

export class InvalidRuntimeManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRuntimeManifestError'
  }
}

export class RuntimeArtifactIntegrityError extends Error {
  constructor(
    readonly file: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(`Runtime artifact integrity mismatch for ${file}: expected ${expectedSha256}, got ${actualSha256}`)
    this.name = 'RuntimeArtifactIntegrityError'
  }
}

export class RuntimeVersionConflictError extends Error {
  constructor(readonly version: string) {
    super(`Runtime version ${version} is already installed with different content`)
    this.name = 'RuntimeVersionConflictError'
  }
}

export class RuntimeRollbackUnavailableError extends Error {
  constructor() {
    super('No previous runtime version is available for rollback')
    this.name = 'RuntimeRollbackUnavailableError'
  }
}

function cleanSegment(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || /[\\/\0]/.test(trimmed)) {
    throw new InvalidRuntimeManifestError(`Invalid ${field}`)
  }
  return trimmed
}

function normalizeRuntimeFile(input: RuntimeReleaseFile): RuntimeReleaseFile {
  const rawPath = input.path.trim().replaceAll('\\', '/')
  const normalized = path.posix.normalize(rawPath)
  if (
    !rawPath ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized) ||
    rawPath.startsWith('/') ||
    rawPath.includes('\0')
  ) {
    throw new InvalidRuntimeManifestError(`Unsafe runtime file path: ${input.path}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new InvalidRuntimeManifestError(`Invalid sha256 for ${normalized}`)
  }
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new InvalidRuntimeManifestError(`Invalid size for ${normalized}`)
  }
  if (!input.url.trim()) throw new InvalidRuntimeManifestError(`Missing URL for ${normalized}`)
  return {
    path: normalized,
    sha256: input.sha256.toLowerCase(),
    size: input.size,
    url: input.url.trim(),
    ...(input.executable ? { executable: true } : {}),
  }
}

export function normalizeRuntimeReleaseManifest(
  input: RuntimeReleaseManifest,
): NormalizedRuntimeReleaseManifest {
  if (input?.schemaVersion !== 2 || input.runtime !== 'dsh') {
    throw new InvalidRuntimeManifestError('Unsupported runtime manifest schema/runtime')
  }
  const version = cleanSegment(input.version, 'runtime version')
  const arch = cleanSegment(input.arch, 'runtime architecture')
  if (!input.platform || typeof input.platform !== 'string') {
    throw new InvalidRuntimeManifestError('Invalid runtime platform')
  }
  if (!Number.isSafeInteger(input.protocolVersion) || input.protocolVersion < 1) {
    throw new InvalidRuntimeManifestError('Invalid runtime protocolVersion')
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new InvalidRuntimeManifestError('Runtime manifest must contain files')
  }

  const files = input.files.map(normalizeRuntimeFile).sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  for (const file of files) {
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path
    if (seen.has(key)) throw new InvalidRuntimeManifestError(`Duplicate runtime file: ${file.path}`)
    seen.add(key)
  }

  return {
    schemaVersion: 2,
    runtime: 'dsh',
    version,
    platform: input.platform,
    arch,
    protocolVersion: input.protocolVersion,
    files,
  }
}

export function runtimeManifestDigest(manifest: RuntimeReleaseManifest): string {
  const normalized = normalizeRuntimeReleaseManifest(manifest)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function verifyRuntimeFile(filePath: string, descriptor: RuntimeReleaseFile): Promise<void> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size !== descriptor.size) {
    throw new RuntimeArtifactIntegrityError(descriptor.path, descriptor.sha256, `size:${info.size}`)
  }
  const actual = await sha256File(filePath)
  if (actual !== descriptor.sha256) {
    throw new RuntimeArtifactIntegrityError(descriptor.path, descriptor.sha256, actual)
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

export class RuntimeUpdateManager {
  private readonly root: string
  private readonly versionsRoot: string
  private readonly stateFile: string
  private readonly fetchFile: RuntimeArtifactFetcher
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly now: () => Date

  constructor(options: RuntimeUpdateManagerOptions) {
    this.root = path.resolve(options.root)
    this.versionsRoot = path.join(this.root, 'versions')
    this.stateFile = path.join(this.root, 'active.json')
    this.fetchFile = options.fetchFile
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.now = options.now ?? (() => new Date())
  }

  versionDirectory(version: string): string {
    return path.join(this.versionsRoot, cleanSegment(version, 'runtime version'))
  }

  async state(): Promise<RuntimeActivationState> {
    const parsed = await readJson<RuntimeActivationState>(this.stateFile)
    if (parsed?.schemaVersion === 1 && typeof parsed.updatedAt === 'string') return parsed
    return { schemaVersion: 1, updatedAt: this.now().toISOString() }
  }

  async activeDirectory(): Promise<string | null> {
    const state = await this.state()
    if (!state.current) return null
    const metadata = await this.readInstallMetadata(state.current.version)
    if (!metadata || metadata.manifestDigest !== state.current.manifestDigest) return null
    return this.versionDirectory(state.current.version)
  }

  async prepare(input: RuntimeReleaseManifest): Promise<RuntimePrepareResult> {
    const manifest = normalizeRuntimeReleaseManifest(input)
    if (manifest.platform !== this.platform || manifest.arch !== this.arch) {
      throw new InvalidRuntimeManifestError(
        `Runtime target ${manifest.platform}/${manifest.arch} does not match client ${this.platform}/${this.arch}`,
      )
    }

    const digest = runtimeManifestDigest(manifest)
    const finalDir = this.versionDirectory(manifest.version)
    const existing = await this.readInstallMetadata(manifest.version)
    if (existing) {
      if (existing.manifestDigest !== digest) throw new RuntimeVersionConflictError(manifest.version)
      return {
        version: manifest.version,
        directory: finalDir,
        manifestDigest: digest,
        reusedFiles: manifest.files.length,
        downloadedFiles: 0,
        reusedBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        downloadedBytes: 0,
      }
    }

    await mkdir(this.versionsRoot, { recursive: true })
    const stagingDir = path.join(this.versionsRoot, `.${manifest.version}.staging-${randomUUID()}`)
    await rm(stagingDir, { recursive: true, force: true })
    await mkdir(stagingDir, { recursive: true })

    let reusedFiles = 0
    let downloadedFiles = 0
    let reusedBytes = 0
    let downloadedBytes = 0

    try {
      const active = await this.state()
      const currentMetadata = active.current
        ? await this.readInstallMetadata(active.current.version)
        : null
      const currentFiles = new Map(
        currentMetadata?.manifest.files.map((file) => [file.path, file]) ?? [],
      )
      const currentDir = active.current ? this.versionDirectory(active.current.version) : null

      for (const file of manifest.files) {
        const destination = path.join(stagingDir, ...file.path.split('/'))
        await mkdir(path.dirname(destination), { recursive: true })

        const current = currentFiles.get(file.path)
        const currentPath = currentDir ? path.join(currentDir, ...file.path.split('/')) : null
        if (current && current.sha256 === file.sha256 && currentPath) {
          try {
            await verifyRuntimeFile(currentPath, current)
            await copyFile(currentPath, destination)
            reusedFiles += 1
            reusedBytes += file.size
          } catch {
            await this.fetchFile(file, destination)
            downloadedFiles += 1
            downloadedBytes += file.size
          }
        } else {
          await this.fetchFile(file, destination)
          downloadedFiles += 1
          downloadedBytes += file.size
        }

        await verifyRuntimeFile(destination, file)
        if (file.executable && process.platform !== 'win32') {
          await chmod(destination, 0o755)
        }
      }

      const metadata: RuntimeInstallMetadata = {
        schemaVersion: 1,
        manifestDigest: digest,
        manifest,
        installedAt: this.now().toISOString(),
      }
      await writeFile(
        path.join(stagingDir, '.harnessdock-runtime.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      )

      try {
        await rename(stagingDir, finalDir)
      } catch (error) {
        const raced = await this.readInstallMetadata(manifest.version)
        if (raced?.manifestDigest === digest) {
          await rm(stagingDir, { recursive: true, force: true })
        } else {
          throw error
        }
      }

      return {
        version: manifest.version,
        directory: finalDir,
        manifestDigest: digest,
        reusedFiles,
        downloadedFiles,
        reusedBytes,
        downloadedBytes,
      }
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async activate(version: string): Promise<RuntimeActivationState> {
    const metadata = await this.readInstallMetadata(version)
    if (!metadata) throw new Error(`Runtime ${version} is not prepared`)
    if (metadata.manifest.platform !== this.platform || metadata.manifest.arch !== this.arch) {
      throw new InvalidRuntimeManifestError('Prepared runtime target no longer matches this client')
    }

    const state = await this.state()
    if (state.current?.version === version && state.current.manifestDigest === metadata.manifestDigest) {
      return state
    }

    const next: RuntimeActivationState = {
      schemaVersion: 1,
      current: { version, manifestDigest: metadata.manifestDigest },
      ...(state.current ? { previous: state.current } : {}),
      updatedAt: this.now().toISOString(),
    }
    await writeJsonAtomic(this.stateFile, next)
    return next
  }

  async rollback(): Promise<RuntimeActivationState> {
    const state = await this.state()
    if (!state.previous) throw new RuntimeRollbackUnavailableError()
    const previousMetadata = await this.readInstallMetadata(state.previous.version)
    if (!previousMetadata || previousMetadata.manifestDigest !== state.previous.manifestDigest) {
      throw new RuntimeRollbackUnavailableError()
    }

    const next: RuntimeActivationState = {
      schemaVersion: 1,
      current: state.previous,
      ...(state.current ? { previous: state.current } : {}),
      updatedAt: this.now().toISOString(),
    }
    await writeJsonAtomic(this.stateFile, next)
    return next
  }

  async readInstallMetadata(version: string): Promise<RuntimeInstallMetadata | null> {
    const metadata = await readJson<RuntimeInstallMetadata>(
      path.join(this.versionDirectory(version), '.harnessdock-runtime.json'),
    )
    if (
      !metadata ||
      metadata.schemaVersion !== 1 ||
      typeof metadata.manifestDigest !== 'string' ||
      !metadata.manifest
    ) {
      return null
    }
    try {
      const manifest = normalizeRuntimeReleaseManifest(metadata.manifest)
      const digest = runtimeManifestDigest(manifest)
      if (digest !== metadata.manifestDigest) return null
      return { ...metadata, manifest }
    } catch {
      return null
    }
  }
}
