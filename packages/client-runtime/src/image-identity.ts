import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const IDENTITY_ALGORITHM = 'sha256-v1' as const
const EXCLUDED_ROOT_FILES = new Set(['manifest.json', '.ready'])

export interface RuntimeImageIdentity {
  algorithm: typeof IDENTITY_ALGORITHM
  imageIdentity: string
  contentFileCount: number
  contentBytes: number
}

function portableRelative(value: string): string {
  return value.split(path.sep).join('/')
}

function assertInsideRoot(root: string, target: string, relative: string): void {
  const normalizedRoot = path.resolve(root)
  const normalizedTarget = path.resolve(target)
  const withinRoot =
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  if (!withinRoot) {
    throw new Error(`runtime image entry escapes root: ${relative} -> ${normalizedTarget}`)
  }
}

async function collectRuntimeFiles(root: string, relativeDir = ''): Promise<string[]> {
  const directory = path.join(root, relativeDir)
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(relativeDir, entry.name)
    const portable = portableRelative(relative)
    if (!relativeDir && EXCLUDED_ROOT_FILES.has(entry.name)) continue

    const absolute = path.join(root, relative)
    if (entry.isDirectory()) {
      files.push(...(await collectRuntimeFiles(root, relative)))
      continue
    }
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(absolute)
      assertInsideRoot(root, resolved, portable)
      const resolvedStat = await stat(resolved)
      if (!resolvedStat.isFile()) {
        throw new Error(`runtime image symlink must resolve to a file: ${portable}`)
      }
      files.push(relative)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`unsupported runtime image entry: ${portable}`)
    }
    files.push(relative)
  }

  return files
}

export async function computeRuntimeImageIdentity(root: string): Promise<RuntimeImageIdentity> {
  const absoluteRoot = path.resolve(root)
  const files = (await collectRuntimeFiles(absoluteRoot)).sort((left, right) =>
    portableRelative(left).localeCompare(portableRelative(right)),
  )
  const hash = createHash('sha256')
  let contentBytes = 0

  for (const relative of files) {
    const portable = portableRelative(relative)
    const content = await readFile(path.join(absoluteRoot, relative))
    contentBytes += content.byteLength
    hash.update('file\0')
    hash.update(portable)
    hash.update('\0')
    hash.update(String(content.byteLength))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }

  return {
    algorithm: IDENTITY_ALGORITHM,
    imageIdentity: `sha256:${hash.digest('hex')}`,
    contentFileCount: files.length,
    contentBytes,
  }
}

export async function assertRuntimeImageIdentity(
  root: string,
  manifest?: Record<string, unknown>,
): Promise<RuntimeImageIdentity> {
  const runtimeManifest =
    manifest ??
    (JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>)
  if (runtimeManifest.imageIdentityAlgorithm !== IDENTITY_ALGORITHM) {
    throw new Error(
      `runtime image identity algorithm ${String(runtimeManifest.imageIdentityAlgorithm ?? 'missing')} != ${IDENTITY_ALGORITHM}`,
    )
  }
  if (typeof runtimeManifest.imageIdentity !== 'string' || runtimeManifest.imageIdentity === '') {
    throw new Error('runtime manifest has no imageIdentity')
  }

  const actual = await computeRuntimeImageIdentity(root)
  if (runtimeManifest.imageIdentity !== actual.imageIdentity) {
    throw new Error(
      `runtime image identity mismatch: manifest=${runtimeManifest.imageIdentity} actual=${actual.imageIdentity}`,
    )
  }
  if (Number(runtimeManifest.contentFileCount) !== actual.contentFileCount) {
    throw new Error(
      `runtime image file count mismatch: manifest=${runtimeManifest.contentFileCount} actual=${actual.contentFileCount}`,
    )
  }
  if (Number(runtimeManifest.contentBytes) !== actual.contentBytes) {
    throw new Error(
      `runtime image byte count mismatch: manifest=${runtimeManifest.contentBytes} actual=${actual.contentBytes}`,
    )
  }

  const budget = Number(runtimeManifest.runtimeSizeBudgetBytes)
  if (Number.isFinite(budget) && budget > 0 && actual.contentBytes > budget) {
    throw new Error(
      `runtime image exceeds size budget: ${actual.contentBytes} bytes > ${budget} bytes`,
    )
  }
  return actual
}
