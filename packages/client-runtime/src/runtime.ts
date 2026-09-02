import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bundledRuntimeVersion, inspectBundledRuntime } from './bundled.ts'
import { ensureDownloadedRuntime, defaultDownloadCacheDir } from './ensure-runtime.ts'
import { buildLaunchArgs, renderEmbeddedPatch } from './launch.ts'
import { parseWebUrl, redactWebAuthTokens } from './output.ts'
import {
  buildPluginRecoveryPlan,
  parseConfigDumpRows,
  renderPluginRecoveryPatch,
  type PluginRecoveryReason,
} from './plugin-recovery.ts'
import {
  clearPluginQuarantine,
  readPluginQuarantine,
  writePluginQuarantine,
} from './plugin-quarantine.ts'
import { shutdownLadder, isProcessAlive, type ShutdownResult } from './process.ts'
import { parseReadyFile } from './ready.ts'
import { resolveDshCommand } from './resolve.ts'
import { resolveRuntimeMode } from './process.ts'
import { buildSpawnRequest } from './shell.ts'
import { openWebUiSession } from './web-auth.ts'
import type { ParsedUrl, ReadyInfo, RuntimeMode } from './types.ts'

export type PluginRecoverySource = 'none' | 'startup-failure' | 'quarantine'

export interface PluginRecoveryState {
  active: boolean
  source: PluginRecoverySource
  isolatedPlugins: string[]
  suspectedPlugins: string[]
  reason?: PluginRecoveryReason
  quarantineExpiresAt?: string
}

export interface DshRuntimeOptions {
  origin: {
    dshVersion: string
    gitTag?: string
    gitCommit?: string
    npmPackage?: string
    npmTarball?: string
    npmIntegrity?: string
    runtimeBundles?: Record<string, { url: string }>
  }
  pluginPath: string
  /** optional host-provided bridge for legacy browser client module imports */
  compatibilityPath?: string
  /** optional independent dsh shell plugin; absent in older compatibility hosts */
  shellPluginPath?: string
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
  readyTimeoutMs?: number
  /** require the child and web UI to stay healthy this long before returning ready */
  readyStabilityMs?: number
  bundledRoot?: string
  spawnImpl?: typeof spawn
  cacheDir?: string
  /** where the download mode vendors the dsh tarball (defaults to defaultDownloadCacheDir) */
  downloadCacheDir?: string
  /** host-owned state; never modifies the user's dsh configuration */
  pluginQuarantinePath?: string
  /** quarantine lifetime; defaults to 24h */
  pluginQuarantineTtlMs?: number
  /** test seam for the boot-free config discovery command */
  configDumpImpl?: () => Promise<string>
  /** hard ceiling for stop(); defaults to 20s so the app can always quit */
  stopTimeoutMs?: number
  /** optional diagnostic sink (boot log in the desktop client) */
  log?: (message: string) => void
  /**
   * Optional progress callback for the first-launch download path. Fired for
   * each dependency tarball that finishes downloading/extracting. Use it to
   * drive a splash screen, progress bar, or activity log.
   */
  onProgress?: (event: RuntimeProgressEvent) => void
  /**
   * The runtime downloader (defaults to ensureDownloadedRuntime). Injectable for
   * tests; used both by the thin "download" mode and by the bundled follow-pin
   * path (Phase B: fetch the pinned dsh version into the cache when the bundled
   * seed pins a different version).
   */
  downloadImpl?: typeof ensureDownloadedRuntime
}

export type RuntimeProgressEvent =
  | { stage: 'resolve'; done?: number; total?: number }
  | {
      stage: 'fetch'
      name: string
      done: number
      total: number
      /** cumulative bytes downloaded across the whole closure (this run) */
      bytes: number
      /** overall completion 0-100, accurate because the full closure is resolved first */
      percent?: number
    }
  | { stage: 'done'; root: string }

export interface StopOutcome {
  /** false when stop() never finished within the safety timeout */
  clean: boolean
  /** ShutdownResult from the ladder; undefined when the ladder was never reached */
  ladder?: ShutdownResult
}

function emptyRecoveryState(): PluginRecoveryState {
  return { active: false, source: 'none', isolatedPlugins: [], suspectedPlugins: [] }
}

export class DshRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private workDir: string | undefined
  private startPromise: Promise<ReadyInfo> | undefined
  private stopPromise: Promise<void> | undefined
  private stopRequested = false
  private stopGeneration = 0
  private stopOutcome: StopOutcome | undefined
  private recoveryState: PluginRecoveryState = emptyRecoveryState()

  constructor(private readonly options: DshRuntimeOptions) {}

  /** How the last stop() ended; call after stop() resolves for diagnostics. */
  get lastStopOutcome(): StopOutcome | undefined {
    return this.stopOutcome
  }

  /** Structured plugin fault-containment state for UI/diagnostics. */
  get pluginRecoveryState(): PluginRecoveryState {
    return {
      ...this.recoveryState,
      isolatedPlugins: [...this.recoveryState.isolatedPlugins],
      suspectedPlugins: [...this.recoveryState.suspectedPlugins],
    }
  }

  async clearPluginQuarantine(): Promise<void> {
    if (this.options.pluginQuarantinePath) {
      await clearPluginQuarantine(this.options.pluginQuarantinePath)
    }
  }

  async start(): Promise<ReadyInfo> {
    if (this.startPromise) return this.startPromise

    // A new start may follow a completed stop. If a stop is still in flight,
    // wait for that specific stop and only proceed when no newer stop request
    // arrived in the meantime.
    const pendingStop = this.stopPromise
    const observedStopGeneration = this.stopGeneration
    if (!pendingStop) this.stopRequested = false
    const operation = (async (): Promise<ReadyInfo> => {
      if (pendingStop) await pendingStop
      if (this.stopGeneration !== observedStopGeneration || this.stopRequested) {
        throw new Error('dsh runtime start cancelled by stop request.')
      }
      if (this.child) {
        throw new Error('dsh runtime is already running; call stop() before start().')
      }
      this.stopOutcome = undefined
      this.recoveryState = emptyRecoveryState()
      try {
        return await this.startImpl()
      } catch (error) {
        await this.cleanupRuntimeArtifacts()
        throw error
      }
    })()
    this.startPromise = operation
    try {
      return await operation
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined
    }
  }

  private async startImpl(): Promise<ReadyInfo> {
    this.assertStartActive()
    const env = { ...process.env, ...this.options.env }
    if (this.options.packaged) {
      await verifyPackagedPlugin(this.options.pluginPath, this.options.log)
      if (this.options.shellPluginPath) {
        await verifyPackagedPlugin(this.options.shellPluginPath, this.options.log, 'harness shell plugin')
      }
    }
    const bundledAvailable = this.options.bundledRoot
      ? inspectBundledRuntime(this.options.bundledRoot, process.platform) !== null
      : false
    const mode: RuntimeMode = resolveRuntimeMode({
      env,
      packaged: this.options.packaged ?? false,
      bundledAvailable,
    })
    const version = env.DSH_RUNTIME_VERSION ?? this.options.origin.dshVersion
    this.options.log?.(
      `runtime: mode=${mode} packaged=${this.options.packaged ?? false} ` +
        `bundledAvailable=${bundledAvailable} version=${version}`,
    )
    let command = await resolveDshCommand({
      mode,
      version,
      env,
      bundledRoot: this.options.bundledRoot,
    })

    if (mode === 'download') {
      const downloaded = await ensureDownloadedRuntime({
        origin: this.options.origin,
        env,
        cacheDir: this.options.downloadCacheDir ?? defaultDownloadCacheDir(),
        onProgress: this.options.onProgress,
      })
      const bundledLayout = this.options.bundledRoot
        ? inspectBundledRuntime(this.options.bundledRoot, process.platform)
        : null
      if (bundledLayout) {
        const bundledCommand = await resolveDshCommand({
          mode: 'bundled',
          version,
          env,
          bundledRoot: this.options.bundledRoot,
        })
        command = { command: bundledCommand.command, argsPrefix: [downloaded.dshBin] }
      } else {
        command = {
          command: process.execPath,
          argsPrefix: [downloaded.dshBin],
        }
      }
    } else if (
      mode === 'bundled' &&
      this.options.bundledRoot &&
      env.DSH_BUNDLED_FETCH === '1'
    ) {
      const seedVersion = bundledRuntimeVersion(this.options.bundledRoot)
      if (seedVersion && seedVersion !== version) {
        const download = this.options.downloadImpl ?? ensureDownloadedRuntime
        const downloaded = await download({
          origin: this.options.origin,
          env,
          cacheDir: this.options.downloadCacheDir ?? defaultDownloadCacheDir(),
          onProgress: this.options.onProgress,
        }).then(
          (value) => value,
          (error: unknown) => {
            this.options.log?.(
              `bundled: pinned dsh ${version} != seed ${seedVersion}; online fetch failed (` +
                `${error instanceof Error ? error.message : String(error)}); using bundled seed`,
            )
            return null
          },
        )
        if (downloaded) {
          const bundledLayout = inspectBundledRuntime(this.options.bundledRoot, process.platform)
          if (bundledLayout) {
            const bundledCommand = await resolveDshCommand({
              mode: 'bundled',
              version,
              env,
              bundledRoot: this.options.bundledRoot,
            })
            command = { command: bundledCommand.command, argsPrefix: [downloaded.dshBin] }
            this.options.log?.(
              `bundled: using pinned dsh ${version} from cache (seed was ${seedVersion})`,
            )
          }
        }
      }
    }

    this.assertStartActive()
    this.workDir = await mkdtemp(path.join(this.options.cacheDir ?? os.tmpdir(), 'harnessdock-'))
    this.assertStartActive()
    const patchFile = path.join(this.workDir, 'embedded.patch.yml')
    const readyFile = path.join(this.workDir, 'ready.json')
    await writeFile(
      patchFile,
      renderEmbeddedPatch(
        this.options.pluginPath,
        this.options.compatibilityPath,
        this.options.shellPluginPath,
      ),
      'utf8',
    )

    const childEnv = {
      ...env,
      ...command.extraEnv,
      DSH_EMBEDDED_READY_FILE: readyFile,
      DSH_EMBEDDED_VERSION: version,
    }
    const dumpEnv = { ...env, ...command.extraEnv }
    const spawnImpl = this.options.spawnImpl ?? spawn

    const spawnRuntime = (recoveryPatchFile?: string): ChildProcessWithoutNullStreams => {
      this.assertStartActive()
      const launchArgs = buildLaunchArgs({ patchFile })
      if (recoveryPatchFile) {
        const hostIndex = launchArgs.indexOf('--host')
        launchArgs.splice(hostIndex < 0 ? launchArgs.length : hostIndex, 0, '--patch', recoveryPatchFile)
      }
      const args = [...command.argsPrefix, ...launchArgs]
      const spawnRequest = buildSpawnRequest(command.command, args)
      this.options.log?.(
        `runtime: spawning ${[spawnRequest.command, ...spawnRequest.args]
          .map((value) => JSON.stringify(value))
          .join(' ')}`,
      )
      return spawnImpl(spawnRequest.command, spawnRequest.args, {
        cwd: this.options.cwd ?? process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) as unknown as ChildProcessWithoutNullStreams
    }

    const captureConfigDump = async (): Promise<string> => {
      if (this.options.configDumpImpl) return this.options.configDumpImpl()
      const args = [
        ...command.argsPrefix,
        '--profile',
        'web',
        '--patch',
        patchFile,
        '--dump-config',
      ]
      const spawnRequest = buildSpawnRequest(command.command, args)
      return new Promise<string>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams
        try {
          child = spawnImpl(spawnRequest.command, spawnRequest.args, {
            cwd: this.options.cwd ?? process.cwd(),
            env: dumpEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }) as unknown as ChildProcessWithoutNullStreams
        } catch (error) {
          reject(error)
          return
        }
        this.child = child
        let stdout = ''
        let stderr = ''
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (this.child === child) this.child = undefined
          if (error) reject(error)
          else resolve(stdout)
        }
        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000)
        })
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          if (stderr.length > 64_000) stderr = stderr.slice(-64_000)
        })
        child.once('error', (error) => finish(error))
        child.once('exit', (code) => {
          if (code === 0) finish()
          else finish(new Error(`dsh --dump-config exited with code ${code}: ${redactWebAuthTokens(stderr.slice(-4_000))}`))
        })
        timer = setTimeout(() => {
          void terminateRuntimeChild(child)
          finish(new Error('dsh --dump-config timed out after 15s'))
        }, 15_000)
        timer.unref?.()
      })
    }

    const timeoutMs = this.options.readyTimeoutMs ?? 120_000
    const stabilityMs = this.options.readyStabilityMs ?? 1_000
    const recoveryEnabled = this.options.packaged === true && env.HARNESSDOCK_PLUGIN_RECOVERY !== '0'

    // Circuit breaker: a recently proven external-plugin isolation set may be
    // applied before the normal boot. It is host-owned, version-scoped and
    // expiring; an invalid quarantine is cleared and never blocks normal boot.
    if (recoveryEnabled && this.options.pluginQuarantinePath) {
      const quarantine = await readPluginQuarantine(this.options.pluginQuarantinePath, version)
      if (quarantine) {
        this.assertStartActive()
        const quarantinePatchFile = path.join(this.workDir, 'plugin-quarantine.patch.yml')
        await writeFile(
          quarantinePatchFile,
          renderPluginRecoveryPatch(quarantine.isolatedPlugins.map((id) => ({ id }))),
          'utf8',
        )
        await rm(readyFile, { force: true }).catch(() => undefined)
        this.options.log?.(
          `runtime: applying plugin quarantine before boot (${quarantine.isolatedPlugins.length} external row(s), expires ${quarantine.expiresAt})`,
        )
        const quarantineChild = spawnRuntime(quarantinePatchFile)
        this.child = quarantineChild
        try {
          const ready = await waitForReady(
            quarantineChild,
            readyFile,
            version,
            timeoutMs,
            stabilityMs,
            this.options.log,
            () => this.stopRequested,
          )
          this.assertStartActive()
          this.recoveryState = {
            active: true,
            source: 'quarantine',
            isolatedPlugins: [...quarantine.isolatedPlugins],
            suspectedPlugins: [...quarantine.suspectedPlugins],
            reason: quarantine.reason,
            quarantineExpiresAt: quarantine.expiresAt,
          }
          drainOutput(quarantineChild, this.options.log)
          return ready
        } catch (quarantineError) {
          this.options.log?.(
            `runtime: quarantined boot failed; clearing stale quarantine and retrying normal configuration: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
          )
          await terminateRuntimeChild(quarantineChild)
          this.child = undefined
          if (this.stopRequested) throw quarantineError
          await clearPluginQuarantine(this.options.pluginQuarantinePath).catch(() => undefined)
          await rm(readyFile, { force: true }).catch(() => undefined)
          this.recoveryState = emptyRecoveryState()
        }
      }
    }

    this.assertStartActive()
    const child = spawnRuntime()
    this.child = child

    try {
      const ready = await waitForReady(
        child,
        readyFile,
        version,
        timeoutMs,
        stabilityMs,
        this.options.log,
        () => this.stopRequested,
      )
      this.assertStartActive()
      drainOutput(child, this.options.log)
      return ready
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error)
      this.options.log?.(`runtime: dsh did not become ready: ${diagnostic}`)
      await terminateRuntimeChild(child)
      this.child = undefined

      if (this.stopRequested) throw error
      if (!recoveryEnabled) throw error

      let dump = ''
      try {
        dump = await captureConfigDump()
      } catch (dumpError) {
        this.options.log?.(
          `runtime: plugin recovery skipped because config dump failed: ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`,
        )
        throw error
      }
      this.assertStartActive()
      const plan = buildPluginRecoveryPlan(parseConfigDumpRows(dump), diagnostic)
      const selected = plan.isolationRows
      if (selected.length === 0) {
        this.options.log?.('runtime: plugin recovery found no third-party/user-added rows; preserving original failure')
        throw error
      }

      const recoveryPatchFile = path.join(this.workDir, 'plugin-recovery.patch.yml')
      await writeFile(recoveryPatchFile, renderPluginRecoveryPatch(selected), 'utf8')
      await rm(readyFile, { force: true }).catch(() => undefined)
      const ids = selected.map((row) => row.id)
      const suspectedIds = plan.suspectedRows.map((row) => row.id)
      this.options.log?.(
        `runtime: compatibility recovery isolating ${ids.length} external row(s) for this session: ${ids.join(', ')}`,
      )

      this.assertStartActive()
      const recoveryChild = spawnRuntime(recoveryPatchFile)
      this.child = recoveryChild
      try {
        const ready = await waitForReady(
          recoveryChild,
          readyFile,
          version,
          timeoutMs,
          stabilityMs,
          this.options.log,
          () => this.stopRequested,
        )
        this.assertStartActive()
        let quarantineExpiresAt: string | undefined
        if (this.options.pluginQuarantinePath) {
          try {
            const record = await writePluginQuarantine(this.options.pluginQuarantinePath, {
              dshVersion: version,
              isolatedPlugins: ids,
              suspectedPlugins: suspectedIds,
              reason: plan.reason,
              ttlMs: this.options.pluginQuarantineTtlMs,
            })
            quarantineExpiresAt = record.expiresAt
          } catch (quarantineError) {
            this.options.log?.(
              `runtime: failed to persist non-fatal plugin quarantine: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
            )
          }
        }
        this.recoveryState = {
          active: true,
          source: 'startup-failure',
          isolatedPlugins: ids,
          suspectedPlugins: suspectedIds,
          reason: plan.reason,
          ...(quarantineExpiresAt ? { quarantineExpiresAt } : {}),
        }
        drainOutput(recoveryChild, this.options.log)
        this.options.log?.(
          `runtime: compatibility recovery succeeded; user configuration was not modified; isolated: ${ids.join(', ')}`,
        )
        return ready
      } catch (recoveryError) {
        const recoveryDiagnostic = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        await terminateRuntimeChild(recoveryChild)
        this.child = undefined
        throw new Error(
          `dsh failed to start normally and compatibility recovery also failed. ` +
            `Normal failure: ${diagnostic}\nRecovery failure: ${recoveryDiagnostic}`,
        )
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopGeneration += 1
    this.stopRequested = true
    this.stopOutcome = undefined
    const start = this.startPromise
    const operation = (async (): Promise<void> => {
      const child = this.child
      this.child = undefined
      if (child?.pid) {
        const started = Date.now()
        const result = await Promise.race<ShutdownResult>([
          shutdownLadder(child, {
            termMs: 5_000,
            killMs: 3_000,
            isAlive: () => isProcessAlive(child.pid),
          }),
          new Promise<ShutdownResult>((resolve) => {
            setTimeout(() => {
              resolve({ dead: false, survivors: child.pid ? [child.pid] : [] })
            }, this.options.stopTimeoutMs ?? 20_000).unref()
          }),
        ])
        this.stopOutcome = { clean: result.dead, ladder: result }
        if (!result.dead && this.options.log) {
          this.options.log(
            `dsh process tree not fully stopped after ${Date.now() - started}ms; survivors: ${result.survivors.join(', ')}`,
          )
        }
      }

      // start() can be between an awaited preparation step and its first
      // spawn. It observes stopRequested and rejects; wait for that rejection
      // before deleting its temporary directory so no late startup can revive
      // a process after the host requested shutdown.
      await start?.catch(() => undefined)
      const lateChild = this.child
      this.child = undefined
      if (lateChild && lateChild !== child) await terminateRuntimeChild(lateChild)
      await this.cleanupWorkDir()
      if (!this.stopOutcome) this.stopOutcome = { clean: true }
    })()
    this.stopPromise = operation
    try {
      await operation
    } finally {
      if (this.stopPromise === operation) this.stopPromise = undefined
    }
  }

  private assertStartActive(): void {
    if (this.stopRequested) throw new Error('dsh runtime start cancelled by stop request.')
  }

  private async cleanupWorkDir(): Promise<void> {
    if (!this.workDir) return
    await rm(this.workDir, { recursive: true, force: true }).catch(() => undefined)
    this.workDir = undefined
  }

  private async cleanupRuntimeArtifacts(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child) await terminateRuntimeChild(child)
    await this.cleanupWorkDir()
  }
}

async function terminateRuntimeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || !isProcessAlive(child.pid)) return
  await shutdownLadder(child, {
    termMs: 1_500,
    killMs: 1_500,
    isAlive: () => isProcessAlive(child.pid),
  }).catch(() => undefined)
}

const DRAIN_CHUNK_LIMIT = 2000
const DRAIN_TOTAL_LIMIT = 256_000
const drained = new WeakSet<ChildProcessWithoutNullStreams>()

export function drainOutput(
  child: ChildProcessWithoutNullStreams,
  log?: (message: string) => void,
): void {
  if (drained.has(child)) return
  drained.add(child)
  const onData = createOutputForwarder(log)
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
}

function createOutputForwarder(
  log?: (message: string) => void,
): (chunk: Buffer | string) => void {
  let forwarded = 0
  let capped = false
  return (chunk) => {
    if (!log || capped) return
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const safe = redactWebAuthTokens(raw)
    const remaining = DRAIN_TOTAL_LIMIT - forwarded
    const text = safe.slice(0, Math.max(0, remaining))
    forwarded += text.length
    for (let offset = 0; offset < text.length; offset += DRAIN_CHUNK_LIMIT) {
      log(`[dsh] ${text.slice(offset, offset + DRAIN_CHUNK_LIMIT)}`)
    }
    if (safe.length > remaining) {
      capped = true
      log(`[dsh] output capped after ${DRAIN_TOTAL_LIMIT} characters`)
    }
  }
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  readyFile: string,
  dshVersion: string,
  timeoutMs: number,
  stabilityMs: number,
  log?: (message: string) => void,
  shouldCancel?: () => boolean,
): Promise<ReadyInfo> {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    let candidate: ReadyInfo | undefined
    let candidateSince = 0
    let validating = false
    const forwardOutput = createOutputForwarder(log)
    const appendOutput = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (buffer.length > 16_000) buffer = buffer.slice(-16_000)
    }
    const diagnostics = () => {
      const output = redactWebAuthTokens(buffer.trim())
      return output === '' ? '' : `\nLast dsh output:\n${output.slice(-4_000)}`
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (info: ReadyInfo) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(info)
    }
    const onError = (error: Error) => fail(error)
    const onExit = (code: number | null) => {
      fail(new Error(`dsh exited before ready (code ${code})${diagnostics()}`))
    }
    const onData = (chunk: Buffer | string) => {
      appendOutput(chunk)
      forwardOutput(chunk)
      const parsed = parseWebUrl(buffer)
      if (parsed) consider({ ...parsed, pid: child.pid ?? 0, dshVersion })
    }
    const consider = (info: ReadyInfo): void => {
      if (candidate?.url === info.url) return
      candidate = info
      candidateSince = Date.now()
    }
    const validateCandidate = async (): Promise<void> => {
      if (shouldCancel?.()) {
        fail(new Error('dsh runtime start cancelled by stop request.'))
        return
      }
      if (settled || validating || !candidate || Date.now() - candidateSince < stabilityMs) return
      validating = true
      const current = candidate
      const ready = child.exitCode === null && await probeHttpReady(current.url)
      validating = false
      if (shouldCancel?.()) {
        fail(new Error('dsh runtime start cancelled by stop request.'))
        return
      }
      if (settled || candidate !== current) return
      if (!ready) {
        candidate = undefined
        candidateSince = 0
        return
      }
      succeed(current)
    }
    const poll = setInterval(() => {
      if (shouldCancel?.()) {
        fail(new Error('dsh runtime start cancelled by stop request.'))
        return
      }
      void validateCandidate()
      void readFile(readyFile, 'utf8')
        .then((raw) => {
          const info = parseReadyFile(raw)
          if (info) consider(info)
        })
        .catch(() => undefined)
    }, 100)
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for dsh web ready after ${timeoutMs}ms${diagnostics()}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(poll)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }

    if (!child.stdout || !child.stderr) {
      fail(new Error('dsh child stdio is not piped'))
      return
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function probeHttpReady(url: string): Promise<boolean> {
  return (await openWebUiSession(url, { timeoutMs: 1_000 })) !== null
}

async function verifyPackagedPlugin(
  pluginPath: string,
  log?: (message: string) => void,
  label = 'embedded-client plugin',
): Promise<void> {
  try {
    const details = await stat(pluginPath)
    if (!details.isFile()) throw new Error('path is not a file')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `packaged ${label} is unavailable: ${pluginPath} (${detail}). Reinstall HarnessDock or use the thin package to redownload the runtime.`,
    )
  }
  log?.(`runtime: ${label} verified at ${pluginPath}`)
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
