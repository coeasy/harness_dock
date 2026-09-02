import { app, net, Notification } from 'electron'
import { isProcessAlive } from '@dsh/client-runtime'
import {
  acquireRuntimeLease,
  LocalRuntimeProvider,
  RuntimeLeaseConflictError,
} from '@dsh/bootstrap'
import { startHarnessGateway } from '@dsh/bootstrap/gateway'
import type {
  RuntimeHealth,
  RuntimeService,
  RuntimeSession,
  RuntimeStatus,
} from '@dsh/bootstrap/client-core'
import { bootLogEvent } from './boot-log.ts'
import { captureCurrentSessionSnapshot } from './session-snapshot.ts'
import { recordRuntimeCrash, clearRuntimeCrashHistory } from './runtime-recovery.ts'
import { resolveManagedRuntimeSelection } from './runtime-update-service.ts'
import { bundledRoot, compatibilityPath, originPath, pluginPath, shellPluginPath } from './paths.ts'
import { createWindow } from './window/main-window.ts'
import { appState } from './state.ts'
import { refreshTray } from './tray.ts'
import path from 'node:path'

function currentSession(): RuntimeSession {
  const appUrl = appState.runtimeAppUrl ?? appState.runtimeEndpoint
  if (!appUrl) throw new Error('Local runtime is not connected')
  return {
    provider: 'local',
    appUrl,
    connectedAt: new Date().toISOString(),
    ...(appState.dshVersion ? { dshVersion: appState.dshVersion } : {}),
    ...(appState.dshPid ? { runtimePid: appState.dshPid } : {}),
    metadata: {
      runtimeState: appState.runtimeState,
      ...(appState.mode ? { mode: appState.mode } : {}),
      managedRuntime: Boolean(appState.managedRuntimeVersion),
    },
  }
}

function setRuntimeState(state: typeof appState.runtimeState): void {
  appState.runtimeState = state
  if (appState.tray) refreshTray(appState.tray)
}

async function runtimeHealth(): Promise<RuntimeHealth> {
  const pid = appState.dshPid
  if (!pid || !isProcessAlive(pid)) {
    return { ok: false, provider: 'local', message: 'Local dsh process is not running.' }
  }
  const endpoint = appState.runtimeEndpoint
  if (!endpoint) return { ok: false, provider: 'local', message: 'Local runtime endpoint is unavailable.' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  timeout.unref()
  try {
    const response = await net.fetch(endpoint, { method: 'HEAD', redirect: 'manual', signal: controller.signal })
    return {
      ok: response.status > 0 && response.status < 500,
      provider: 'local',
      appUrl: endpoint,
      ...(appState.dshVersion ? { dshVersion: appState.dshVersion } : {}),
      ...(response.status >= 500 ? { message: `Runtime HTTP health returned ${response.status}.` } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      provider: 'local',
      appUrl: endpoint,
      ...(appState.dshVersion ? { dshVersion: appState.dshVersion } : {}),
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function createRuntimeProvider(preferredVersion?: string): Promise<LocalRuntimeProvider> {
  const userDataDir = app.getPath('userData')
  const managed = await resolveManagedRuntimeSelection(userDataDir)
  appState.managedRuntimeVersion = managed?.version
  const versionOverride = managed?.version ?? preferredVersion
  return new LocalRuntimeProvider({
    originPath: originPath(),
    pluginPath: pluginPath(),
    compatibilityPath: compatibilityPath(),
    shellPluginPath: shellPluginPath(),
    packaged: app.isPackaged,
    bundledRoot: managed?.directory ?? bundledRoot(),
    userDataDir,
    ...(versionOverride ? { versionOverride } : {}),
    stopTimeoutMs: 12_000,
    enableRollback: !managed,
    log: (message) => void bootLogEvent({ level: 'info', component: 'runtime', event: 'runtime_log', message }),
    onRollback: (info) => {
      void bootLogEvent({
        level: 'warn',
        component: 'runtime',
        event: 'runtime_rolled_back',
        data: info,
      })
    },
  })
}

async function restartRemoteGatewayIfEnabled(upstreamUrl: string): Promise<void> {
  if (process.env.HARNESSDOCK_GATEWAY_ENABLE !== '1') return
  const rawPort = process.env.HARNESSDOCK_GATEWAY_PORT?.trim()
  const port = rawPort ? Number.parseInt(rawPort, 10) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HARNESSDOCK_GATEWAY_PORT: ${rawPort}`)
  }
  const gateway = await startHarnessGateway({
    upstreamUrl,
    bindHost: process.env.HARNESSDOCK_GATEWAY_BIND?.trim() || '127.0.0.1',
    port,
    publicBaseUrl: process.env.HARNESSDOCK_GATEWAY_PUBLIC_URL?.trim() || undefined,
    allowInsecurePublicUrl: process.env.HARNESSDOCK_GATEWAY_ALLOW_INSECURE === '1',
    log: (message) => void bootLogEvent({ level: 'info', component: 'gateway', event: 'gateway_log', message }),
  })
  appState.gateway = gateway
}

async function rebindWindow(appUrl: string): Promise<void> {
  const current = appState.mainWindow
  if (!current || current.isDestroyed()) return
  const wasVisible = current.isVisible()
  current.destroy()
  appState.mainWindow = undefined
  await createWindow(appUrl)
  if (!wasVisible) appState.mainWindow?.hide()
}

async function bindProvider(provider: LocalRuntimeProvider, session: RuntimeSession): Promise<void> {
  const result = provider.bootstrapResult
  if (!result) throw new Error('LocalRuntimeProvider connected without a bootstrap result.')
  appState.runtimeProvider = provider
  appState.runtime = result.runtime
  appState.dshPid = result.ready.pid
  appState.dshVersion = result.ready.dshVersion
  appState.runtimeAppUrl = session.appUrl
  appState.runtimeEndpoint = new URL(session.appUrl).origin
  appState.mode = result.mode
  appState.bundledAvailable = result.bundledAvailable
  appState.managedRuntimeVersion = (await resolveManagedRuntimeSelection(app.getPath('userData')))?.version
  const lease = appState.runtimeLease
  if (!lease) throw new Error('Runtime started without an owned runtime lease')
  await lease.updateRuntime({
    runtimePid: result.ready.pid,
    runtimeId: `dsh:${result.ready.dshVersion}`,
    endpoint: appState.runtimeEndpoint,
    dshVersion: result.ready.dshVersion,
    protocolVersion: 1,
  })
  startRuntimeLeaseHeartbeat()
  startRuntimeSupervisor()
}

async function stopRuntimeProcess(releaseLease: boolean): Promise<void> {
  if (!appState.runtime && !appState.runtimeProvider && !appState.gateway) {
    if (releaseLease) {
      stopRuntimeLeaseHeartbeat()
      const lease = appState.runtimeLease
      appState.runtimeLease = undefined
      await lease?.release().catch(() => undefined)
    }
    setRuntimeState('stopped')
    return
  }

  setRuntimeState('stopping')
  appState.runtimeSupervisorStop?.()
  appState.runtimeSupervisorStop = undefined

  const gateway = appState.gateway
  appState.gateway = undefined
  await gateway?.stop().catch(() => undefined)

  const provider = appState.runtimeProvider
  const runtime = appState.runtime
  appState.runtimeProvider = undefined
  appState.runtime = undefined
  if (provider) await provider.disconnect()
  else await runtime?.stop()

  appState.dshPid = undefined
  appState.dshVersion = undefined
  appState.runtimeEndpoint = undefined
  appState.runtimeAppUrl = undefined
  appState.mode = undefined
  appState.bundledAvailable = undefined

  if (releaseLease) {
    stopRuntimeLeaseHeartbeat()
    const lease = appState.runtimeLease
    appState.runtimeLease = undefined
    await lease?.release().catch(() => undefined)
  }

  setRuntimeState('stopped')
  await bootLogEvent({ level: 'info', component: 'runtime', event: 'runtime_stopped' })
}

async function startRuntimeProcess(
  preferredVersion: string | undefined,
  lifecycleState: 'connecting' | 'restarting',
  reloadWindow = true,
): Promise<RuntimeSession> {
  if (!appState.runtimeLease) {
    appState.runtimeLease = await acquireRuntimeLease({ host: 'electron', protocolVersion: 1 })
  }
  setRuntimeState(lifecycleState)
  const provider = await createRuntimeProvider(preferredVersion)
  appState.runtimeProvider = provider
  try {
    const session = await provider.connect()
    await bindProvider(provider, session)
    await restartRemoteGatewayIfEnabled(session.appUrl)
    setRuntimeState('ready')
    if (reloadWindow) await rebindWindow(session.appUrl)
    await bootLogEvent({
      level: 'info',
      component: 'runtime',
      event: lifecycleState === 'restarting' ? 'runtime_restarted' : 'runtime_connected',
      data: { version: appState.dshVersion, pid: appState.dshPid },
    })
    return currentSession()
  } catch (error) {
    await provider.disconnect().catch(() => undefined)
    if (appState.runtimeProvider === provider) appState.runtimeProvider = undefined
    appState.runtime = undefined
    appState.dshPid = undefined
    appState.runtimeEndpoint = undefined
    appState.runtimeAppUrl = undefined
    setRuntimeState('degraded')
    throw error
  }
}

async function restartRuntime(captureSnapshot = true): Promise<RuntimeSession> {
  const preferredVersion = appState.dshVersion
  if (captureSnapshot) await captureCurrentSessionSnapshot().catch(() => undefined)
  await bootLogEvent({ level: 'info', component: 'runtime', event: 'runtime_restart_requested' })
  await stopRuntimeProcess(false)
  const session = await startRuntimeProcess(preferredVersion, 'restarting')
  const health = await runtimeHealth()
  if (!health.ok) throw new Error(health.message || 'Runtime restart failed health verification')
  return session
}

export function createElectronRuntimeService(): RuntimeService {
  return {
    async status(): Promise<RuntimeStatus> {
      let health: RuntimeHealth | undefined
      if (appState.runtimeState === 'ready' || appState.runtimeState === 'degraded') {
        health = await runtimeHealth()
      }
      let session: RuntimeSession | undefined
      try {
        session = currentSession()
      } catch {
        // stopped/disconnected
      }
      return {
        state: appState.runtimeState,
        provider: 'local',
        ...(session ? { session } : {}),
        ...(health ? { health } : {}),
        updatedAt: new Date().toISOString(),
      }
    },
    async connect() {
      if (appState.runtimeState === 'ready' && appState.dshPid && isProcessAlive(appState.dshPid)) {
        return currentSession()
      }
      return startRuntimeProcess(appState.dshVersion, 'connecting')
    },
    health: runtimeHealth,
    restart: () => restartRuntime(true),
    stop: () => stopRuntimeProcess(false),
    disconnect: () => stopRuntimeProcess(true),
  }
}

let handlingLeaseLoss = false

export function startRuntimeLeaseHeartbeat(intervalMs = 10_000): void {
  if (appState.leaseHeartbeat) clearInterval(appState.leaseHeartbeat)
  const timer = setInterval(() => {
    const lease = appState.runtimeLease
    if (!lease) return
    void lease.heartbeat({
      ...(appState.runtimeEndpoint ? { endpoint: appState.runtimeEndpoint } : {}),
      protocolVersion: 1,
    }).catch((error) => {
      void bootLogEvent({
        level: 'warn',
        component: 'runtime',
        event: 'lease_heartbeat_failed',
        message: error instanceof Error ? error.message : String(error),
      })
      if (!(error instanceof RuntimeLeaseConflictError) || handlingLeaseLoss) return
      handlingLeaseLoss = true
      stopRuntimeLeaseHeartbeat()
      appState.runtimeLease = undefined
      void stopRuntimeProcess(false)
        .catch(() => undefined)
        .finally(() => {
          setRuntimeState('degraded')
          handlingLeaseLoss = false
        })
    })
  }, intervalMs)
  timer.unref()
  appState.leaseHeartbeat = timer
}

export function stopRuntimeLeaseHeartbeat(): void {
  if (!appState.leaseHeartbeat) return
  clearInterval(appState.leaseHeartbeat)
  appState.leaseHeartbeat = undefined
}

export function startRuntimeSupervisor(pollMs = 4_000): () => void {
  appState.runtimeSupervisorStop?.()
  const crashFile = path.join(app.getPath('userData'), 'client-state', 'runtime-crashes.v1.json')
  let handlingCrash = false
  let stableSince = Date.now()
  let pendingRestart: NodeJS.Timeout | undefined
  const timer = setInterval(() => {
    if (handlingCrash || appState.quitting || appState.runtimeState !== 'ready') return
    const pid = appState.dshPid
    if (pid && isProcessAlive(pid)) {
      if (Date.now() - stableSince > 5 * 60_000) {
        stableSince = Date.now()
        void clearRuntimeCrashHistory(crashFile).catch(() => undefined)
      }
      return
    }
    handlingCrash = true
    setRuntimeState('crashed')
    void recordRuntimeCrash(crashFile).then(async (decision) => {
      await bootLogEvent({
        level: 'error',
        component: 'runtime',
        event: 'runtime_crashed',
        data: { attempt: decision.attempt, automaticRestartAllowed: decision.allowed },
      })
      if (!decision.allowed) {
        setRuntimeState('degraded')
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: 'HarnessDock runtime stopped',
              body: 'Automatic restart was paused after repeated crashes. Open Diagnostics before restarting.',
            }).show()
          }
        } catch {
          // notifications are optional
        }
        return
      }
      setRuntimeState('restarting')
      pendingRestart = setTimeout(() => {
        pendingRestart = undefined
        void restartRuntime(true).then(() => {
          stableSince = Date.now()
          handlingCrash = false
        }).catch(async (error) => {
          setRuntimeState('degraded')
          await bootLogEvent({
            level: 'error',
            component: 'runtime',
            event: 'runtime_recovery_failed',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      }, decision.delayMs)
      pendingRestart.unref()
    }).catch(async (error) => {
      setRuntimeState('degraded')
      await bootLogEvent({
        level: 'error',
        component: 'runtime',
        event: 'runtime_recovery_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }, pollMs)
  timer.unref()
  const stop = () => {
    clearInterval(timer)
    if (pendingRestart) clearTimeout(pendingRestart)
    pendingRestart = undefined
  }
  appState.runtimeSupervisorStop = stop
  return stop
}
