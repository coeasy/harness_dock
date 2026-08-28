import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bundledRuntimeVersion, inspectBundledRuntime } from './bundled.ts'
import { ensureDownloadedRuntime, defaultDownloadCacheDir } from './fetch-runtime.ts'
import { scrubElectronEnv } from './env.ts'
import { buildLaunchArgs, renderEmbeddedPatch } from './launch.ts'
import { parseWebUrl } from './output.ts'
import { shutdownLadder, isProcessAlive, type ShutdownResult } from './process.ts'
import { parseReadyFile } from './ready.ts'
import { resolveDshCommand } from './resolve.ts'
import { resolveRuntimeMode } from './process.ts'
import { buildSpawnRequest } from './shell.ts'
import type { ParsedUrl, ReadyInfo, RuntimeMode } from './types.ts'

export interface DshRuntimeOptions {
  origin: { dshVersion: string }
  pluginPath: string
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
  readyTimeoutMs?: number
  bundledRoot?: string
  spawnImpl?: typeof spawn
  cacheDir?: string
  /** where the download mode vendors the dsh tarball (defaults to defaultDownloadCacheDir) */
  downloadCacheDir?: string
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

export class DshRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private workDir: string | undefined
  private stopping = false
  private stopOutcome: StopOutcome | undefined

  constructor(private readonly options: DshRuntimeOptions) {}

  /** How the last stop() ended; call after stop() resolves for diagnostics. */
  get lastStopOutcome(): StopOutcome | undefined {
    return this.stopOutcome
  }

  async start(): Promise<ReadyInfo> {
    const env = { ...process.env, ...this.options.env }
    if (this.options.packaged) {
      await verifyPackagedPlugin(this.options.pluginPath, this.options.log)
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
      // Vendored runtime fetched over plain HTTPS from registry mirrors;
      // no npm/npx needed on the target machine.
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
        command = { command: bundledLayout.nodeBin, argsPrefix: [downloaded.dshBin] }
      } else {
        // Thin package has no vendored node: reuse the Electron binary in
        // plain-Node mode (or the host node during development).
        command = {
          command: process.execPath,
          argsPrefix: [downloaded.dshBin],
          extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
        }
      }
    } else if (
      mode === 'bundled' &&
      this.options.bundledRoot &&
      process.env.DSH_BUNDLED_FETCH !== '0'
    ) {
      // Phase B: decouple the dsh runtime from the client. The bundled runtime
      // is the offline seed; when it pins a different dsh version than the one
      // requested, prefer the pinned version fetched into the cache (reusing the
      // thin download pipeline: per-version cache, resume, integrity). Offline /
      // fetch failure falls back to the seed. Opt out with DSH_BUNDLED_FETCH=0.
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
            command = { command: bundledLayout.nodeBin, argsPrefix: [downloaded.dshBin] }
            this.options.log?.(
              `bundled: using pinned dsh ${version} from cache (seed was ${seedVersion})`,
            )
          }
        }
      }
    }

    this.workDir = await mkdtemp(path.join(this.options.cacheDir ?? os.tmpdir(), 'harnessdock-'))
    const patchFile = path.join(this.workDir, 'embedded.patch.yml')
    const readyFile = path.join(this.workDir, 'ready.json')
    await writeFile(patchFile, renderEmbeddedPatch(this.options.pluginPath), 'utf8')

    const childEnv = scrubElectronEnv({
      ...env,
      ...command.extraEnv,
      DSH_EMBEDDED_READY_FILE: readyFile,
      DSH_EMBEDDED_VERSION: version,
    })
    const args = [...command.argsPrefix, ...buildLaunchArgs({ patchFile })]
    const spawnRequest = buildSpawnRequest(command.command, args)
    this.options.log?.(
      `runtime: spawning ${[spawnRequest.command, ...spawnRequest.args]
        .map((value) => JSON.stringify(value))
        .join(' ')}`,
    )
    const spawnImpl = this.options.spawnImpl ?? spawn
    const child = spawnImpl(spawnRequest.command, spawnRequest.args, {
      cwd: this.options.cwd ?? process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as ChildProcessWithoutNullStreams
    this.child = child

    const timeoutMs = this.options.readyTimeoutMs ?? 120_000
    try {
      const ready = await waitForReady(child, readyFile, version, timeoutMs)
      // waitForReady detaches its own 'data' listeners once ready; keep the
      // pipes drained so dsh never blocks on a full OS pipe buffer.
      drainOutput(child, this.options.log)
      return ready
    } catch (error) {
      this.options.log?.(
        `runtime: dsh did not become ready: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.stopOutcome = undefined
    const child = this.child
    this.child = undefined
    if (child?.pid) {
      const started = Date.now()
      // Total budget: the app must always be able to quit, even when a
      // descendant refuses to die or wmic hangs on a broken machine.
      const result = await Promise.race<ShutdownResult>([
        shutdownLadder(child, {
          termMs: 5_000,
          killMs: 3_000,
          // OS-level check: exitCode can lag behind a process that kept living.
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
    if (this.workDir) {
      await rm(this.workDir, { recursive: true, force: true }).catch(() => undefined)
      this.workDir = undefined
    }
    if (!this.stopOutcome) this.stopOutcome = { clean: true }
  }
}

/** A single forwarded log line is capped here to keep the boot log bounded. */
const DRAIN_CHUNK_LIMIT = 2000

const drained = new WeakSet<ChildProcessWithoutNullStreams>()

/**
 * Attaches persistent stdout/stderr consumers so the OS pipe buffers never
 * fill up once waitForReady() detaches its own 'data' listeners. Without this,
 * a chatty dsh that outwrites the ~64 KB pipe buffer would block forever on
 * its own output. Each chunk is converted to utf8 and forwarded to `log` with
 * a `[dsh] ` prefix (truncated to DRAIN_CHUNK_LIMIT characters); when no log is
 * supplied an empty consumer is still attached so the pipes keep draining.
 * A given child is only mounted once.
 */
export function drainOutput(
  child: ChildProcessWithoutNullStreams,
  log?: (message: string) => void,
): void {
  if (drained.has(child)) return
  drained.add(child)
  const onData = (chunk: Buffer | string) => {
    if (!log) return
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const text = raw.length > DRAIN_CHUNK_LIMIT ? raw.slice(0, DRAIN_CHUNK_LIMIT) : raw
    log(`[dsh] ${text}`)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  readyFile: string,
  dshVersion: string,
  timeoutMs: number,
): Promise<ReadyInfo> {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    let stdoutReady: ParsedUrl | undefined
    let probingStdout = false
    const appendOutput = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Keep diagnostics useful without retaining unbounded child output.
      if (buffer.length > 16_000) buffer = buffer.slice(-16_000)
    }
    const diagnostics = () => {
      const output = buffer.trim()
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
      const parsed = parseWebUrl(buffer)
      if (parsed) stdoutReady = parsed
      void probeStdoutUrl()
    }
    const probeStdoutUrl = async (): Promise<void> => {
      if (settled || probingStdout || !stdoutReady) return
      probingStdout = true
      const parsed = stdoutReady
      const ready = await probeHttpReady(parsed.url)
      probingStdout = false
      if (ready && !settled) {
        succeed({
          ...parsed,
          pid: child.pid ?? 0,
          dshVersion,
        })
      }
    }
    const poll = setInterval(() => {
      void probeStdoutUrl()
      void readFile(readyFile, 'utf8')
        .then((raw) => {
          const info = parseReadyFile(raw)
          if (info) succeed(info)
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    if (!response.ok) return false
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType !== '' && !contentType.includes('text/html')) return false
    const body = await response.text()
    return body.trim().length > 0
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function verifyPackagedPlugin(
  pluginPath: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    const details = await stat(pluginPath)
    if (!details.isFile()) throw new Error('path is not a file')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `packaged embedded-client plugin is unavailable: ${pluginPath} (${detail}). Reinstall HarnessDock or use the thin package to redownload the runtime.`,
    )
  }
  log?.(`runtime: embedded plugin verified at ${pluginPath}`)
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
