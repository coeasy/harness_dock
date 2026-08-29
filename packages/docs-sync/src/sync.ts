import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractGuideCapabilities, hashDocs } from './docs.ts'
import { fetchGuideDocs, listDshGitTags } from './github.ts'
import { buildCapabilityMatrix, renderCapabilityMatrixMarkdown, renderCapabilityMatrixYaml } from './matrix.ts'
import { fetchNpmPackageMeta, listNpmVersions } from './npm.ts'
import { buildOrigin, diffOrigin } from './origin.ts'
import { inspectPublishedPackage } from './tarball.ts'
import type { Origin } from './types.ts'
import {
  pickLatestVersion,
  rejectFloatingDistTag,
  versionToGitTag,
} from './versions.ts'

const DEFAULT_CLIENT_VERSION = '0.1.0'
const here = path.dirname(fileURLToPath(import.meta.url))
export const ORIGIN_PATH = path.resolve(here, '..', 'origin.json')
export const MATRIX_PATH = path.resolve(here, '..', 'capability-matrix.yaml')
export const SUMMARY_PATH = path.resolve(here, '..', 'capability-summary.md')

/** Resolve the HarnessDock client version from the repo root package.json. */
export function resolveClientVersion(): string {
  try {
    const rootPackageJson = JSON.parse(
      readFileSync(path.resolve(here, '../../..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return rootPackageJson.version ?? DEFAULT_CLIENT_VERSION
  } catch {
    return DEFAULT_CLIENT_VERSION
  }
}

/** Override the on-disk output locations (used by tests to isolate writes). */
export interface SyncPaths {
  origin?: string
  matrix?: string
  summary?: string
}

export interface SyncOptions {
  pin?: string
  check?: boolean
  dryRun?: boolean
  fetchImpl?: typeof fetch
  paths?: SyncPaths
}

export interface SyncResult {
  origin: Origin
  changed: boolean
  fields: string[]
  written: boolean
}

/**
 * Track the newest exact dsh Git release even when the CLI family has not yet
 * been published to npm. npm-backed versions retain their integrity/tarball;
 * Git-only versions are marked `git-pack` and the release workflow builds the
 * package family from the exact tag/commit using upstream's official recipe.
 */
export async function syncDsh(options: SyncOptions = {}): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const pin = options.pin ? rejectFloatingDistTag(options.pin) : undefined
  const clientVersion = resolveClientVersion()
  const originPath = options.paths?.origin ?? ORIGIN_PATH
  const matrixPath = options.paths?.matrix ?? MATRIX_PATH
  const summaryPath = options.paths?.summary ?? SUMMARY_PATH

  const [gitTags, npmVersions] = await Promise.all([
    listDshGitTags(fetchImpl),
    listNpmVersions(fetchImpl),
  ])
  if (gitTags.length === 0) {
    throw new Error('No exact dsh-v* Git tags are available')
  }

  const gitVersions = gitTags.map((tag) => tag.version)
  const version = pin ?? pickLatestVersion(gitVersions)
  const tag = gitTags.find((entry) => entry.version === version)
  if (!tag) {
    throw new Error(
      `Pin ${version} is not an exact dsh Git tag. Available: ${gitVersions.sort().join(', ')}`,
    )
  }

  const gitTag = tag.tag ?? versionToGitTag(version)
  const gitCommit = tag.sha
  if (!gitCommit) throw new Error(`Missing git commit for ${gitTag}`)

  const npmAvailable = npmVersions.includes(version)
  let npmIntegrity = ''
  let npmTarball = ''
  if (npmAvailable) {
    const npmMeta = await fetchNpmPackageMeta(version, fetchImpl)
    const tarball = inspectPublishedPackage(npmMeta)
    if (!tarball.ok) {
      throw new Error(
        `Refusing ${version}: ${tarball.reason}. The npm version exists but its artifact is unusable.`,
      )
    }
    npmIntegrity = tarball.integrity
    npmTarball = tarball.tarball
  }

  const docs = await fetchGuideDocs(gitTag, fetchImpl)
  const guideMarkdown = docs['docs/user/guide/index.zh.md'] ?? docs['docs/user/guide/index.md'] ?? ''
  const origin = buildOrigin({
    dshVersion: version,
    gitTag,
    gitCommit,
    distribution: npmAvailable ? 'npm' : 'git-pack',
    npmIntegrity,
    npmTarball,
    docsHash: hashDocs(docs),
    clientVersion,
  })
  const matrix = buildCapabilityMatrix({
    dshVersion: version,
    gitTag,
    guide: extractGuideCapabilities(guideMarkdown),
    dumpConfig: '',
  })

  const current = await readOriginFile(originPath).catch(() => null)
  const diff = current ? diffOrigin(current, origin) : { changed: true, fields: ['*'] }

  if (options.check) {
    return { origin, changed: diff.changed, fields: diff.fields, written: false }
  }

  if (!options.dryRun && diff.changed) {
    await mkdir(path.dirname(originPath), { recursive: true })
    await writeFile(originPath, `${JSON.stringify(origin, null, 2)}\n`, 'utf8')
    await writeFile(matrixPath, renderCapabilityMatrixYaml(matrix), 'utf8')
    await writeFile(summaryPath, renderCapabilityMatrixMarkdown(matrix), 'utf8')
  }

  return {
    origin,
    changed: diff.changed,
    fields: diff.fields,
    written: !options.dryRun && diff.changed,
  }
}

export async function readOriginFile(filePath = ORIGIN_PATH): Promise<Origin> {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw) as Origin
}
