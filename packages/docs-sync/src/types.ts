export interface GuideCapability {
  id: string
  title: string
  source: string
}

export type DshDistribution = 'npm' | 'git-pack'

export interface Origin {
  dshVersion: string
  gitTag: string
  gitCommit: string
  /** npm when the exact CLI tarball exists, git-pack when HarnessDock packs the exact tag itself. */
  distribution?: DshDistribution
  npmPackage: '@deepseek-ai/dsh'
  /** Empty for git-pack origins that have no official CLI tarball yet. */
  npmIntegrity: string
  /** Empty for git-pack origins that have no official CLI tarball yet. */
  npmTarball: string
  docsHash: string
  syncedAt: string
  clientVersion: string
}

export interface NpmPackageMeta {
  version: string
  bin?: Record<string, string>
  dist?: {
    fileCount?: number
    integrity?: string
    tarball?: string
  }
}

export interface TarballOk {
  ok: true
  integrity: string
  tarball: string
}

export interface TarballFail {
  ok: false
  reason: string
}

export type TarballInspection = TarballOk | TarballFail

export interface CapabilityOperation {
  id: string
  title: string
  source: string
}

export interface CapabilityMatrix {
  dshVersion: string
  gitTag: string
  hostMounts: Record<string, boolean>
  operations: CapabilityOperation[]
}

export const REQUIRED_HOST_MOUNTS = [
  'api-gateway',
  'directory-picker',
  'workspace',
  'host-frontend-static',
] as const
