import {
  installRuntimeBundle,
  installRuntimeDelta,
  type RuntimeProgressEvent,
} from '@dsh/client-runtime'
import {
  resolveReleaseArtifactUrl,
  type PlannedDelivery,
  type ReleaseManifestV2,
} from './update-orchestrator.ts'

export interface RuntimeUpdateApplyResult {
  targetVersion: string
  delivery: 'delta' | 'full'
  fellBackFromDelta: boolean
}

export interface ApplyPlannedRuntimeUpdateOptions {
  manifest: ReleaseManifestV2
  delivery: PlannedDelivery
  runtimeDir: string
  platform?: NodeJS.Platform
  arch?: string
  gitTag?: string
  gitCommit?: string
  onProgress?: (event: RuntimeProgressEvent) => void
  log?: (message: string) => void
  /** Injectable installers for tests. */
  installFull?: typeof installRuntimeBundle
  installDelta?: typeof installRuntimeDelta
}

/**
 * Apply a Runtime delivery selected by createUpdatePlan(). Delta application is
 * always opportunistic: any download, base-tree, extraction or final-integrity
 * failure automatically falls back to the canonical full Runtime artifact.
 */
export async function applyPlannedRuntimeUpdate(
  options: ApplyPlannedRuntimeUpdateOptions,
): Promise<RuntimeUpdateApplyResult> {
  const { delivery, manifest } = options
  if (delivery.artifact.component !== 'runtime') {
    throw new Error(`cannot apply non-runtime artifact as Runtime: ${delivery.artifact.assetName}`)
  }
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (delivery.artifact.platform !== platform || delivery.artifact.arch !== arch) {
    throw new Error(
      `runtime artifact ${delivery.artifact.platform}/${delivery.artifact.arch} does not match host ${platform}/${arch}`,
    )
  }

  const targetVersion = delivery.artifact.version
  const full = options.installFull ?? installRuntimeBundle
  const deltaInstaller = options.installDelta ?? installRuntimeDelta

  if (delivery.mode === 'delta' && delivery.delta) {
    const deltaUrl = delivery.delta.url ?? resolveReleaseArtifactUrl(manifest, delivery.delta)
    try {
      options.log?.(
        `runtime update: applying delta ${delivery.delta.fromVersion} -> ${targetVersion} (${delivery.delta.size} bytes)`,
      )
      await deltaInstaller({
        spec: {
          url: deltaUrl,
          sha256: delivery.delta.sha256,
          size: delivery.delta.size,
        },
        runtimeDir: options.runtimeDir,
        targetVersion,
        platform,
        arch,
        onProgress: options.onProgress,
      })
      options.log?.(`runtime update: delta committed -> ${targetVersion}`)
      return { targetVersion, delivery: 'delta', fellBackFromDelta: false }
    } catch (error) {
      options.log?.(
        `runtime update: delta failed; falling back to full Runtime: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const fullUrl = resolveReleaseArtifactUrl(manifest, delivery.artifact)
  options.log?.(`runtime update: installing canonical full Runtime ${targetVersion} (${delivery.artifact.size} bytes)`)
  await full({
    spec: {
      url: fullUrl,
      sha256: delivery.artifact.sha256,
      size: delivery.artifact.size,
    },
    version: targetVersion,
    gitTag: options.gitTag,
    gitCommit: options.gitCommit,
    runtimeDir: options.runtimeDir,
    platform,
    arch,
    onProgress: options.onProgress,
  })
  options.log?.(`runtime update: full Runtime committed -> ${targetVersion}`)
  return {
    targetVersion,
    delivery: 'full',
    fellBackFromDelta: delivery.mode === 'delta',
  }
}
