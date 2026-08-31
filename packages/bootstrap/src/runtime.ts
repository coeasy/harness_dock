import path from 'node:path'
import {
  DshRuntime,
  inspectBundledRuntime,
  resolveRuntimeMode,
  type ReadyInfo,
  type RuntimeMode,
  type RuntimeProgressEvent,
} from '@dsh/client-runtime'
import { readOriginFile, type Origin } from '@dsh/docs-sync'
import { backupOrigin, readPreviousOrigin } from './rollback.ts'

/**
 * Shared host bootstrap orchestration (used by both the Electron desktop shell
 * and the VS Code / Cursor extension):
 *
 *   read origin → resolve runtime mode → backup last-known-good → construct
 *   DshRuntime → start (with rollback to last-known-good on failure) → ready.
 *
 * Hosts supply paths + callbacks and receive a started runtime. Everything else
 * is injected so the flow is unit-testable and identical across hosts.
 */

export interface BootstrapOptions {
  /** path to the pinned origin.json */
  originPath: string
  /**
   * Request a specific dsh version instead of the one pinned in origin.json.
   * Applied right after the origin is read (and before onBeforeStart), so the
   * whole flow (mode resolution, download, rollback, ready file) runs against
   * the requested version. Empty string / undefined = use the pinned version.
   */
  versionOverride?: string
  /** path to the embedded-client plugin (cordis patch target) */
  pluginPath: string
  /** optional host-provided bridge for legacy browser client module imports */
  compatibilityPath?: string
  /** whether we are running inside a packaged app */
  packaged: boolean
  /** bundled runtime root (resources/dsh-runtime) when present */
  bundledRoot?: string
  /** host user-data dir; used for rollback, runtime cache and plugin quarantine */
  userDataDir?: string
  /** override for the runtime download cache dir (defaults to userDataDir/runtime-cache) */
  downloadCacheDir?: string
  /** override for the previous-origin backup path (defaults to userDataDir/previous-origin.json) */
  previousOriginPath?: string
  /** override for host-owned plugin quarantine state */
  pluginQuarantinePath?: string
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** diagnostic sink (boot log in the desktop client) */
  log?: (message: string) => void
  /** first-launch / pinned-version download progress */
  onProgress?: (event: RuntimeProgressEvent) => void
  /** fired after origin read + mode resolution, before the runtime starts */
  onBeforeStart?: (info: { origin: Origin; mode: RuntimeMode; bundledAvailable: boolean }) => void
  /** fired when a rollback to last-known-good happened */
  onRollback?: (info: { from: string; to: string }) => void
  /** set false to disable the last-known-good rollback */
  enableRollback?: boolean
  /** injectable DshRuntime factory (tests) */
  dshRuntimeFactory?: (origin: Origin) => DshRuntime
}

export interface BootstrapResult {
  runtime: DshRuntime
  ready: ReadyInfo
  origin: Origin
  mode: RuntimeMode
  bundledAvailable: boolean
  rolledBack: { from: string; to: string } | null
}

export async function bootstrapRuntime(options: BootstrapOptions): Promise<BootstrapResult> {
  const log = options.log
  const env = { ...process.env, ...options.env }
  let origin = await readOriginFile(options.originPath)
  if (options.versionOverride && options.versionOverride.trim().length > 0) {
    origin = { ...origin, dshVersion: options.versionOverride }
    log?.(`bootstrap: version override -> dsh ${options.versionOverride}`)
  }
  const bundledAvailable = options.bundledRoot
    ? inspectBundledRuntime(options.bundledRoot, process.platform) !== null
    : false
  const mode = resolveRuntimeMode({ env, packaged: options.packaged, bundledAvailable })
  const previousOriginPath =
    options.previousOriginPath ??
    (options.userDataDir ? path.join(options.userDataDir, 'previous-origin.json') : undefined)
  const downloadCacheDir =
    options.downloadCacheDir ??
    (options.userDataDir ? path.join(options.userDataDir, 'runtime-cache') : undefined)
  const pluginQuarantinePath =
    options.pluginQuarantinePath ??
    (options.userDataDir ? path.join(options.userDataDir, 'plugin-quarantine.json') : undefined)

  options.onBeforeStart?.({ origin, mode, bundledAvailable })

  const makeRuntime = (o: Origin): DshRuntime =>
    options.dshRuntimeFactory
      ? options.dshRuntimeFactory(o)
      : new DshRuntime({
          origin: o,
          pluginPath: options.pluginPath,
          compatibilityPath: options.compatibilityPath,
          packaged: options.packaged,
          bundledRoot: options.bundledRoot,
          downloadCacheDir,
          pluginQuarantinePath,
          readyTimeoutMs: options.readyTimeoutMs,
          stopTimeoutMs: options.stopTimeoutMs,
          log,
          onProgress: options.onProgress,
          env: options.env,
        })

  let runtime = makeRuntime(origin)
  let ready: ReadyInfo
  let rolledBack: { from: string; to: string } | null = null
  try {
    ready = await runtime.start()
    if (previousOriginPath) {
      await backupOrigin(options.originPath, previousOriginPath, log)
    }
  } catch (startError) {
    const previous =
      options.enableRollback === false
        ? null
        : previousOriginPath
          ? await readPreviousOrigin(previousOriginPath, origin.dshVersion)
          : null
    if (previous) {
      log?.(
        `bootstrap: new dsh ${origin.dshVersion} failed to start; attempting last-known-good ${previous.dshVersion}`,
      )
      const fallbackRuntime = makeRuntime(previous.origin as unknown as Origin)
      try {
        ready = await fallbackRuntime.start()
        runtime = fallbackRuntime
        rolledBack = { from: origin.dshVersion, to: previous.dshVersion }
        log?.(`bootstrap: rolled back to last-known-good dsh ${previous.dshVersion}`)
        options.onRollback?.(rolledBack)
      } catch (fallbackError) {
        log?.(
          `bootstrap: rollback also failed: ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`,
        )
        throw startError
      }
    } else {
      throw startError
    }
  }

  return { runtime, ready, origin, mode, bundledAvailable, rolledBack }
}
