import type { HarnessHostId } from './host-capabilities.ts'

export type UpdateChannel = 'stable' | 'beta' | 'nightly'
export type PackageRuntimeMode = 'full' | 'thin' | 'system' | 'remote'
export type UpdateComponent = 'host' | 'runtime'
export type UpdateRestartScope = 'none' | 'runtime' | 'app'

export interface UpdateDeltaArtifact {
  fromVersion: string
  fromSha256?: string
  assetName: string
  url?: string
  sha256: string
  size: number
  format: 'blockmap' | 'runtime-overlay-tar.gz' | 'bsdiff' | 'zstd-diff'
}

export interface ReleaseArtifactV2 {
  id: string
  component: UpdateComponent
  version: string
  channel: UpdateChannel
  platform: string
  arch: string
  host?: HarnessHostId
  runtimeMode?: PackageRuntimeMode
  format: string
  assetName: string
  url?: string
  sha256: string
  size: number
  signatureAsset?: string
  critical?: boolean
  deltas?: UpdateDeltaArtifact[]
}

export interface ReleaseManifestV2 {
  schemaVersion: 2
  generatedAt: string
  release: {
    version: string
    channel: UpdateChannel
    tag?: string
  }
  source?: {
    provider: 'github' | 'generic'
    repository?: string
    baseUrl?: string
  }
  artifacts: ReleaseArtifactV2[]
}

export interface InstalledUpdateContext {
  host: HarnessHostId
  hostVersion: string
  hostSha256?: string
  runtimeVersion?: string
  runtimeSha256?: string
  runtimeMode: PackageRuntimeMode
  /**
   * True when the active Runtime lives in a HarnessDock-managed mutable store.
   * Thin defaults to true. Current Full packages run their signed bundled seed
   * in-place, so they default to false until the v0.2 managed-runtime migration.
   */
  runtimeManaged?: boolean
  platform: string
  arch: string
  channel: UpdateChannel
  preferredFormats?: string[]
}

export interface PlannedDelivery {
  mode: 'full' | 'delta'
  artifact: ReleaseArtifactV2
  delta?: UpdateDeltaArtifact
}

export interface UpdatePlan {
  host?: PlannedDelivery
  runtime?: PlannedDelivery
  restart: UpdateRestartScope
  critical: boolean
  targetHostVersion?: string
  targetRuntimeVersion?: string
}

export type UpdatePhase =
  | 'available'
  | 'downloading'
  | 'staged'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'

export interface UpdateTransaction {
  id: string
  phase: UpdatePhase
  plan: UpdatePlan
  createdAt: string
  updatedAt: string
  attempt: number
  error?: string
}

export interface UpdatePolicy {
  check: 'manual' | 'startup' | 'periodic'
  download: 'manual' | 'automatic'
  install: 'manual' | 'idle' | 'immediate'
  restart: 'prompt' | 'idle' | 'immediate'
  idleSeconds: number
}

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = {
  check: 'periodic',
  download: 'automatic',
  install: 'manual',
  restart: 'prompt',
  idleSeconds: 300,
}

const PHASE_TRANSITIONS: Record<UpdatePhase, readonly UpdatePhase[]> = {
  available: ['downloading', 'failed'],
  downloading: ['staged', 'failed'],
  staged: ['installing', 'failed'],
  installing: ['restarting', 'verifying', 'failed', 'rolled-back'],
  restarting: ['verifying', 'failed', 'rolled-back'],
  verifying: ['succeeded', 'failed', 'rolled-back'],
  succeeded: [],
  failed: ['rolled-back'],
  'rolled-back': [],
}

export function assertReleaseManifestV2(value: unknown): asserts value is ReleaseManifestV2 {
  if (!value || typeof value !== 'object') throw new Error('release manifest must be an object')
  const manifest = value as Partial<ReleaseManifestV2>
  if (manifest.schemaVersion !== 2) throw new Error(`unsupported release manifest schema: ${String(manifest.schemaVersion)}`)
  if (!manifest.release || typeof manifest.release.version !== 'string') {
    throw new Error('release manifest is missing release.version')
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error('release manifest artifacts must be an array')
  for (const artifact of manifest.artifacts) validateArtifact(artifact)
}

export async function fetchReleaseManifestV2(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseManifestV2> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`release manifest request failed: HTTP ${response.status} ${url}`)
  const value: unknown = await response.json()
  assertReleaseManifestV2(value)
  return value
}

export function githubLatestReleaseManifestUrl(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`)
  }
  return `https://github.com/${repository}/releases/latest/download/release-manifest.json`
}

export function resolveReleaseArtifactUrl(
  manifest: ReleaseManifestV2,
  artifact: Pick<ReleaseArtifactV2, 'assetName' | 'url'>,
): string {
  if (artifact.url) return artifact.url
  if (manifest.source?.baseUrl) {
    return `${manifest.source.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(artifact.assetName)}`
  }
  if (manifest.source?.provider === 'github' && manifest.source.repository && manifest.release.tag) {
    return `https://github.com/${manifest.source.repository}/releases/download/${encodeURIComponent(manifest.release.tag)}/${encodeURIComponent(artifact.assetName)}`
  }
  throw new Error(`cannot resolve URL for release artifact ${artifact.assetName}`)
}

export function createUpdatePlan(
  manifest: ReleaseManifestV2,
  current: InstalledUpdateContext,
): UpdatePlan | null {
  assertReleaseManifestV2(manifest)

  const hostArtifact = pickBestArtifact(
    manifest.artifacts.filter(
      (artifact) =>
        artifact.component === 'host' &&
        artifact.channel === current.channel &&
        artifact.host === current.host &&
        artifact.platform === current.platform &&
        artifact.arch === current.arch &&
        artifact.runtimeMode === current.runtimeMode &&
        compareVersions(artifact.version, current.hostVersion) > 0,
    ),
    current.preferredFormats ?? preferredFormats(current.platform),
  )

  const runtimeManaged = current.runtimeManaged ?? current.runtimeMode === 'thin'
  const runtimeArtifact =
    !runtimeManaged || !current.runtimeVersion
      ? undefined
      : pickBestArtifact(
          manifest.artifacts.filter(
            (artifact) =>
              artifact.component === 'runtime' &&
              artifact.channel === current.channel &&
              artifact.platform === current.platform &&
              artifact.arch === current.arch &&
              compareVersions(artifact.version, current.runtimeVersion ?? '0.0.0') > 0,
          ),
          ['tar.gz', 'zip'],
        )

  if (!hostArtifact && !runtimeArtifact) return null

  const host = hostArtifact
    ? selectDelivery(hostArtifact, current.hostVersion, current.hostSha256)
    : undefined
  const runtime = runtimeArtifact
    ? selectDelivery(runtimeArtifact, current.runtimeVersion ?? '0.0.0', current.runtimeSha256)
    : undefined

  return {
    host,
    runtime,
    restart: host ? 'app' : runtime ? 'runtime' : 'none',
    critical: Boolean(hostArtifact?.critical || runtimeArtifact?.critical),
    targetHostVersion: hostArtifact?.version,
    targetRuntimeVersion: runtimeArtifact?.version,
  }
}

export function selectDelivery(
  artifact: ReleaseArtifactV2,
  currentVersion: string,
  currentSha256?: string,
): PlannedDelivery {
  const deltas = (artifact.deltas ?? [])
    .filter(
      (delta) =>
        delta.fromVersion === currentVersion &&
        (!delta.fromSha256 || (Boolean(currentSha256) && delta.fromSha256 === currentSha256)) &&
        delta.size > 0 &&
        delta.size < artifact.size,
    )
    .sort((left, right) => left.size - right.size)

  return deltas[0]
    ? { mode: 'delta', artifact, delta: deltas[0] }
    : { mode: 'full', artifact }
}

export function createUpdateTransaction(
  plan: UpdatePlan,
  input: { id?: string; now?: Date; attempt?: number } = {},
): UpdateTransaction {
  const now = (input.now ?? new Date()).toISOString()
  return {
    id: input.id ?? `update-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    phase: 'available',
    plan,
    createdAt: now,
    updatedAt: now,
    attempt: input.attempt ?? 1,
  }
}

export function transitionUpdateTransaction(
  transaction: UpdateTransaction,
  next: UpdatePhase,
  input: { now?: Date; error?: string } = {},
): UpdateTransaction {
  if (!PHASE_TRANSITIONS[transaction.phase].includes(next)) {
    throw new Error(`invalid update transition: ${transaction.phase} -> ${next}`)
  }
  return {
    ...transaction,
    phase: next,
    updatedAt: (input.now ?? new Date()).toISOString(),
    error: input.error ?? transaction.error,
  }
}

export function shouldInstallAutomatically(
  policy: UpdatePolicy,
  input: { idleSeconds?: number } = {},
): boolean {
  if (policy.install === 'immediate') return true
  if (policy.install !== 'idle') return false
  return (input.idleSeconds ?? 0) >= policy.idleSeconds
}

export function shouldRestartAutomatically(
  policy: UpdatePolicy,
  input: { idleSeconds?: number } = {},
): boolean {
  if (policy.restart === 'immediate') return true
  if (policy.restart !== 'idle') return false
  return (input.idleSeconds ?? 0) >= policy.idleSeconds
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const av = a.pre[index]
    const bv = b.pre[index]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av === bv) continue
    const an = /^\d+$/.test(av) ? Number(av) : undefined
    const bn = /^\d+$/.test(bv) ? Number(bv) : undefined
    if (an !== undefined && bn !== undefined) return an > bn ? 1 : -1
    if (an !== undefined) return -1
    if (bn !== undefined) return 1
    return av > bv ? 1 : -1
  }
  return 0
}

function parseVersion(value: string): { core: [number, number, number]; pre: string[] } {
  const normalized = value.trim().replace(/^v/, '').split('+', 1)[0]
  const [coreText, preText = ''] = normalized.split('-', 2)
  const parts = coreText.split('.')
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`invalid semantic version: ${value}`)
  }
  return {
    core: [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)],
    pre: preText ? preText.split('.') : [],
  }
}

function preferredFormats(platform: string): string[] {
  if (platform === 'win32') return ['nsis', 'msi', 'exe', 'zip']
  if (platform === 'darwin') return ['dmg', 'app', 'zip']
  if (platform === 'linux') return ['appimage', 'deb', 'rpm', 'tar.gz']
  return ['archive']
}

function pickBestArtifact(
  artifacts: ReleaseArtifactV2[],
  formats: string[],
): ReleaseArtifactV2 | undefined {
  return [...artifacts].sort((left, right) => {
    const version = compareVersions(right.version, left.version)
    if (version !== 0) return version
    const leftFormat = formats.indexOf(left.format)
    const rightFormat = formats.indexOf(right.format)
    if (leftFormat !== rightFormat) {
      return (leftFormat < 0 ? Number.MAX_SAFE_INTEGER : leftFormat) -
        (rightFormat < 0 ? Number.MAX_SAFE_INTEGER : rightFormat)
    }
    return left.size - right.size
  })[0]
}

function validateArtifact(artifact: ReleaseArtifactV2): void {
  if (!artifact || typeof artifact !== 'object') throw new Error('release artifact must be an object')
  if (!artifact.id || !artifact.assetName || !artifact.version) throw new Error('release artifact is missing required identity fields')
  if (artifact.component !== 'host' && artifact.component !== 'runtime') {
    throw new Error(`invalid release artifact component: ${String(artifact.component)}`)
  }
  if (artifact.component === 'host' && (!artifact.host || !artifact.runtimeMode)) {
    throw new Error(`host release artifact is missing host/runtimeMode: ${artifact.assetName}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error(`invalid sha256 for ${artifact.assetName}`)
  }
  if (!Number.isFinite(artifact.size) || artifact.size < 0) {
    throw new Error(`invalid size for ${artifact.assetName}`)
  }
  for (const delta of artifact.deltas ?? []) {
    if (!/^[a-f0-9]{64}$/i.test(delta.sha256)) throw new Error(`invalid delta sha256 for ${delta.assetName}`)
    if (!Number.isFinite(delta.size) || delta.size <= 0) throw new Error(`invalid delta size for ${delta.assetName}`)
  }
}
