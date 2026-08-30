export interface GuideCapability {
  id: string
  title: string
  source: string
}

export interface RuntimeBundleSpec {
  url: string
  sha256?: string
  size?: number
}

export interface Origin {
  dshVersion: string
  gitTag: string
  gitCommit: string
  npmPackage: '@deepseek-ai/dsh'
  /** Empty when the pinned upstream prerelease has not been published to npm. */
  npmIntegrity: string
  /** Empty when runtime delivery uses HarnessDock source-built runtime bundles. */
  npmTarball: string
  /** Platform runtime fallback used when the exact upstream dsh version is GitHub-only. */
  runtimeBundles?: Record<string, RuntimeBundleSpec>
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
