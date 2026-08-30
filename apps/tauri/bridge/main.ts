import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  LocalRuntimeProvider,
  RuntimeLeaseConflictError,
  acquireRuntimeLease,
  type RuntimeLeaseHandle,
} from '../../../packages/bootstrap/src/index.ts'
import { parseTauriRuntimeBridgeOptions } from './options.ts'

interface BridgeState {
  schemaVersion: 1
  status: 'starting' | 'ready' | 'error' | 'stopped'
  updatedAt: string
  appUrl?: string
  dshVersion?: string
  runtimePid?: number
  message?: string
}

async function writeStateAtomic(file: string, state: BridgeState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

async function main(): Promise<void> {
  const options = parseTauriRuntimeBridgeOptions()
  await writeStateAtomic(options.stateFile, {
    schemaVersion: 1,
    status: 'starting',
    updatedAt: new Date().toISOString(),
  })

  let lease: RuntimeLeaseHandle | undefined
  let provider: LocalRuntimeProvider | undefined
  let shuttingDown = false
  let shutdownTimer: NodeJS.Timeout | undefined

  const shutdown = async (reason: string, exitCode = 0): Promise<never> => {
    if (shuttingDown) {
      return new Promise<never>(() => undefined)
    }
    shuttingDown = true
    if (shutdownTimer) clearInterval(shutdownTimer)
    console.log(`[tauri-bridge] shutdown: ${reason}`)
    try {
      await provider?.disconnect()
    } catch (error) {
      console.error('[tauri-bridge] runtime stop failed:', error)
    }
    try {
      await lease?.release()
    } catch (error) {
      console.error('[tauri-bridge] lease release failed:', error)
    }
    await writeStateAtomic(options.stateFile, {
      schemaVersion: 1,
      status: 'stopped',
      updatedAt: new Date().toISOString(),
      message: reason,
    }).catch(() => undefined)
    process.exit(exitCode)
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    lease = await acquireRuntimeLease({ host: 'tauri' })
    provider = new LocalRuntimeProvider({
      originPath: options.originPath,
      pluginPath: options.pluginPath,
      packaged: options.packaged,
      bundledRoot: options.bundledRoot,
      userDataDir: options.userDataDir,
      stopTimeoutMs: 12_000,
      log: (message) => console.log(`[tauri-bridge] ${message}`),
      onProgress: (event) => {
        if (event.stage === 'fetch') {
          console.log(
            `[tauri-bridge] runtime download ${event.percent ?? 0}% ${event.name ?? ''}`.trim(),
          )
        }
      },
      onRollback: (info) => {
        console.warn(`[tauri-bridge] rolled back dsh ${info.from} -> ${info.to}`)
      },
    })

    const session = await provider.connect()
    await lease.updateRuntime({ runtimePid: session.runtimePid, dshVersion: session.dshVersion })
    await writeStateAtomic(options.stateFile, {
      schemaVersion: 1,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      appUrl: session.appUrl,
      ...(session.dshVersion ? { dshVersion: session.dshVersion } : {}),
      ...(session.runtimePid === undefined ? {} : { runtimePid: session.runtimePid }),
    })

    // Cross-platform graceful shutdown handshake. Rust writes this marker first
    // and waits for the bridge to stop dsh + release the shared lease before it
    // falls back to terminating the bridge process.
    shutdownTimer = setInterval(() => {
      if (existsSync(options.shutdownFile)) void shutdown('host-shutdown')
    }, 250)
    shutdownTimer.unref()

    // Keep the bridge alive even if the child runtime momentarily has no active
    // JS handles. Runtime health/crash supervision is promoted in M2.
    await new Promise<never>(() => undefined)
  } catch (error) {
    const message =
      error instanceof RuntimeLeaseConflictError
        ? `Another HarnessDock desktop host owns the dsh runtime: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    console.error('[tauri-bridge] startup failed:', error)
    await writeStateAtomic(options.stateFile, {
      schemaVersion: 1,
      status: 'error',
      updatedAt: new Date().toISOString(),
      message,
    }).catch(() => undefined)
    try {
      await provider?.disconnect()
    } catch {}
    try {
      await lease?.release()
    } catch {}
    process.exitCode = 1
  }
}

void main().catch((error) => {
  console.error('[tauri-bridge] fatal:', error)
  process.exitCode = 1
})
