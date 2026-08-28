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
  intersectVersions,
  pickLatestVersion,
  rejectFloatingDistTag,
  versionToGitTag,
} from './versions.ts'

const DEFAULT_CLIENT_VERSION = '0.1.0'
const here = path.dirname(fileURLToPath(import.meta.url))
export const ORIGIN_PATH = path.resolve(here, '..', 'origin.json')
export const MATRIX_PATH = path.resolve(here, '..', 'capability-matrix.yaml')
export const SUMMARY_PATH = path.resolve(here, '..', 'capability-summary.md')

/**
 * Resolve the HarnessDock client version from the repo root package.json.
 * Kept lazy (called inside syncDsh) because sync.ts is bundled by esbuild into
 * the desktop app, which only needs readOriginFile; reading files at module
 * top-level would crash after bundling. Falls back to a default on failure.
 */
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
  const intersection = intersectVersions(
    gitTags.map((t) => t.version),
    npmVersions,
  )
  if (intersection.length === 0) {
    throw new Error('No version exists on both git tags (dsh-v*) and npm @deepseek-ai/dsh')
  }

  const version = pin ?? pickLatestVersion(intersection)
  if (!intersection.includes(version)) {
    throw new Error(
      `Pin ${version} is not in git tag ∩ npm. Available: ${intersection.sort().join(', ')}`,
    )
  }

  const tag = gitTags.find((t) => t.version === version)
  const gitTag = tag?.tag ?? versionToGitTag(version)
  const gitCommit = tag?.sha
  if (!gitCommit) {
    throw new Error(`Missing git commit for ${gitTag}`)
  }

  const npmMeta = await fetchNpmPackageMeta(version, fetchImpl)
  const tarball = inspectPublishedPackage(npmMeta)
  if (!tarball.ok) {
    throw new Error(
      `Refusing ${version}: ${tarball.reason}. Tag exists but the npm artifact is unusable.`,
    )
  }

  const docs = await fetchGuideDocs(gitTag, fetchImpl)
  const guideMarkdown = docs['docs/user/guide/index.zh.md'] ?? docs['docs/user/guide/index.md'] ?? ''
  const origin = buildOrigin({
    dshVersion: version,
    gitTag,
    gitCommit,
    npmIntegrity: tarball.integrity,
    npmTarball: tarball.tarball,
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

  // The summary shares the YAML's write semantics exactly: it is only (re)written
  // on a real change, never in dry-run/check mode, and untouched when unchanged.
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
