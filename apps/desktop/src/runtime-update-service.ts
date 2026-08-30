import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectBundledRuntime } from '@dsh/client-runtime'
import {
  RuntimeUpdateManager,
  initialUpdateSnapshot,
  transitionUpdate,
  type HostUpdateInfo,
  type RuntimeReleaseFile,
  type RuntimeReleaseManifest,
  type RuntimeService,
  type UpdatePhase,
  type UpdateService,
  type UpdateSnapshot,
  type UpdateTarget,
} from '@dsh/bootstrap'
import { bootLogEvent } from './boot-log.ts'
import { captureCurrentSessionSnapshot } from './session-snapshot.ts'
import { appState } from './state.ts'

const execFileAsync = promisify(execFile)

function managedRuntimeRoot(userDataDir: string): string {
  return path.join(userDataDir, 'managed-runtime')
}

async function fetchRuntimeFile(file: RuntimeReleaseFile, destination: string): Promise<void> {
  const url = new URL(file.url)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Runtime artifacts must use HTTPS: ${url.origin}`)
  }
  const response = await net.fetch(url.toString(), { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Runtime artifact download failed (${response.status})`)
  await mkdir(path.dirname(destination), { recursive: true })
  const writer = createWriteStream(destination, { flags: 'w', mode: 0o600 })
  const reader = response.body.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (!writer.write(Buffer.from(result.value))) {
        await new Promise<void>((resolve) => writer.once('drain', resolve))
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject)
      writer.end(resolve)
    })
  } catch (error) {
    writer.destroy()
    await reader.cancel().catch(() => undefined)
    throw error
  }
}

function managerFor(userDataDir: string): RuntimeUpdateManager {
  return new RuntimeUpdateManager({ root: managedRuntimeRoot(userDataDir), fetchFile: fetchRuntimeFile })
}

export async function resolveManagedRuntimeSelection(
  userDataDir: string,
): Promise<{ version: string; directory: string } | null> {
  const manager = managerFor(userDataDir)
  const state = await manager.state()
  if (!state.current) return null
  const directory = await manager.activeDirectory()
  if (!directory) return null
  return { version: state.current.version, directory }
}

export async function rollbackManagedRuntimeSelection(
  userDataDir: string,
): Promise<string | null> {
  try {
    const state = await managerFor(userDataDir).rollback()
    return state.current?.version ?? null
  } catch {
    return null
  }
}

async function selfTestRuntime(directory: string): Promise<void> {
  const layout = inspectBundledRuntime(directory, process.platform)
  if (!layout) throw new Error(`Prepared runtime is incomplete under ${directory}`)
  await execFileAsync(layout.nodeBin, [layout.dshBin, '--version'], {
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    maxBuffer: 1024 * 1024,
  })
}

function runtimeManifestUrl(): string | null {
  const value = process.env.HARNESSDOCK_RUNTIME_MANIFEST_URL?.trim()
  return value || null
}

function safeManifestUrl(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Runtime manifest must use HTTPS (HTTP is allowed only for loopback development)')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  return url
}

class ElectronRuntimeUpdateService implements UpdateService {
  private snapshot: UpdateSnapshot = initialUpdateSnapshot('runtime')
  private manifest: RuntimeReleaseManifest | null = null
  private preparedVersion: string | null = null
  private readonly manager: RuntimeUpdateManager

  constructor(
    private readonly runtime: RuntimeService,
    userDataDir: string,
  ) {
    this.manager = managerFor(userDataDir)
  }

  private advance(phase: UpdatePhase, values: Partial<UpdateSnapshot> = {}): void {
    try {
      this.snapshot = transitionUpdate(this.snapshot, { phase, ...values })
    } catch {
      this.snapshot = {
        ...this.snapshot,
        ...values,
        target: 'runtime',
        phase,
        updatedAt: new Date().toISOString(),
      }
    }
  }

  private fail(error: unknown): void {
    this.advance('failed', { error: error instanceof Error ? error.message : String(error) })
  }

  async state(target: UpdateTarget): Promise<UpdateSnapshot> {
    if (target !== 'runtime') throw new Error(`Runtime updater cannot manage ${target}`)
    return { ...this.snapshot }
  }

  async check(target: UpdateTarget): Promise<HostUpdateInfo | null> {
    if (target !== 'runtime') throw new Error(`Runtime updater cannot manage ${target}`)
    const manifestUrl = runtimeManifestUrl()
    if (!manifestUrl) {
      this.snapshot = {
        ...initialUpdateSnapshot('runtime'),
        ...(appState.dshVersion ? { currentVersion: appState.dshVersion } : {}),
      }
      return null
    }
    this.advance('checking', { currentVersion: appState.dshVersion, error: undefined })
    try {
      const response = await net.fetch(safeManifestUrl(manifestUrl).toString(), {
        headers: { accept: 'application/json' },
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(`Runtime manifest request failed (${response.status})`)
      const manifest = (await response.json()) as RuntimeReleaseManifest
      this.manifest = manifest
      if (manifest.version === appState.dshVersion) {
        this.advance('idle', { nextVersion: undefined })
        return null
      }
      this.advance('available', { nextVersion: manifest.version })
      return {
        target: 'runtime',
        currentVersion: appState.dshVersion ?? 'unknown',
        nextVersion: manifest.version,
      }
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  async download(target: UpdateTarget): Promise<void> {
    if (target !== 'runtime') throw new Error(`Runtime updater cannot manage ${target}`)
    if (!this.manifest) throw new Error('Check for a runtime update before downloading')
    this.advance('downloading', { progress: 0 })
    try {
      const prepared = await this.manager.prepare(this.manifest)
      this.advance('verifying', { progress: 100 })
      await selfTestRuntime(prepared.directory)
      this.preparedVersion = prepared.version
      this.advance('ready', { progress: 100, nextVersion: prepared.version })
      await bootLogEvent({
        level: 'info',
        component: 'runtime-update',
        event: 'runtime_prepared',
        data: {
          version: prepared.version,
          reusedFiles: prepared.reusedFiles,
          downloadedFiles: prepared.downloadedFiles,
        },
      })
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  async install(target: UpdateTarget): Promise<void> {
    if (target !== 'runtime') throw new Error(`Runtime updater cannot manage ${target}`)
    if (!this.preparedVersion) throw new Error('Runtime update is not prepared')
    await captureCurrentSessionSnapshot().catch(() => undefined)
    this.advance('stopping-runtime')
    try {
      this.advance('installing')
      await this.manager.activate(this.preparedVersion)
      this.advance('restart-required')
      this.advance('restarting')
      await bootLogEvent({
        level: 'info',
        component: 'runtime-update',
        event: 'runtime_activated',
        data: { version: this.preparedVersion },
      })
      await this.runtime.restart()
      this.advance('succeeded')
    } catch (error) {
      this.advance('rolling-back')
      const rolledBack = await this.manager.rollback().catch(() => null)
      await bootLogEvent({
        level: 'error',
        component: 'runtime-update',
        event: 'runtime_install_failed',
        message: error instanceof Error ? error.message : String(error),
        data: { rollbackVersion: rolledBack?.current?.version ?? null },
      })
      this.fail(error)
      throw error
    }
  }

  async rollback(target: UpdateTarget): Promise<void> {
    if (target !== 'runtime') throw new Error(`Runtime updater cannot manage ${target}`)
    await captureCurrentSessionSnapshot().catch(() => undefined)
    this.advance('rolling-back')
    try {
      const state = await this.manager.rollback()
      this.advance('restart-required', { nextVersion: state.current?.version })
      this.advance('restarting')
      await this.runtime.restart()
      this.advance('succeeded', { nextVersion: state.current?.version })
    } catch (error) {
      this.fail(error)
      throw error
    }
  }
}

class CompositeUpdateService implements UpdateService {
  constructor(
    private readonly host: UpdateService,
    private readonly runtime: UpdateService,
  ) {}

  private service(target: UpdateTarget): UpdateService {
    if (target === 'host') return this.host
    if (target === 'runtime') return this.runtime
    throw new Error('Plugin updates are owned by the plugin lifecycle, not the desktop host updater')
  }

  state(target: UpdateTarget) { return this.service(target).state(target) }
  check(target: UpdateTarget) { return this.service(target).check(target) }
  download(target: UpdateTarget) { return this.service(target).download(target) }
  install(target: UpdateTarget) { return this.service(target).install(target) }
  rollback(target: UpdateTarget) { return this.service(target).rollback(target) }
}

export function createElectronRuntimeUpdateService(
  runtime: RuntimeService,
  userDataDir = app.getPath('userData'),
): UpdateService {
  return new ElectronRuntimeUpdateService(runtime, userDataDir)
}

export function createCompositeUpdateService(host: UpdateService, runtime: UpdateService): UpdateService {
  return new CompositeUpdateService(host, runtime)
}
