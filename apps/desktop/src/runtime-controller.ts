import { app, net, Notification } from 'electron'
import { isProcessAlive } from '@dsh/client-runtime'
import type {
  RuntimeHealth,
  RuntimeService,
  RuntimeSession,
  RuntimeStatus,
} from '@dsh/bootstrap/client-core'
import { bootLogEvent } from './boot-log.ts'
import { captureCurrentSessionSnapshot } from './session-snapshot.ts'
import { recordRuntimeCrash, clearRuntimeCrashHistory } from './runtime-recovery.ts'
import { appState } from './state.ts'
import { refreshTray } from './tray.ts'
import path from 'node:path'

function currentSession(): RuntimeSession {
  if (!appState.runtimeEndpoint) throw new Error('Local runtime is not connected')
  return {
    provider: 'local',
    appUrl: appState.runtimeEndpoint,
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

async function relaunchRuntime(): Promise<RuntimeSession> {
  let session: RuntimeSession
  try {
    session = currentSession()
  } catch {
    session = { provider: 'local', appUrl: 'http://127.0.0.1/', connectedAt: new Date().toISOString() }
  }
  await captureCurrentSessionSnapshot().catch(() => undefined)
  setRuntimeState('restarting')
  await bootLogEvent({ level: 'info', component: 'runtime', event: 'runtime_restart_requested' })
  app.relaunch()
  app.quit()
  return session
}

export function createElectronRuntimeService(): RuntimeService {
  const stop = async (): Promise<void> => {
    if (!appState.runtime && !appState.gateway) {
      setRuntimeState('stopped')
      return
    }
    setRuntimeState('stopping')
    appState.runtimeSupervisorStop?.()
    appState.runtimeSupervisorStop = undefined
    if (appState.leaseHeartbeat) {
      clearInterval(appState.leaseHeartbeat)
      appState.leaseHeartbeat = undefined
    }
    const gateway = appState.gateway
    appState.gateway = undefined
    await gateway?.stop().catch(() => undefined)
    const runtime = appState.runtime
    appState.runtime = undefined
    await runtime?.stop()
    appState.dshPid = undefined
    appState.dshVersion = undefined
    appState.runtimeEndpoint = undefined
    const lease = appState.runtimeLease
    appState.runtimeLease = undefined
    await lease?.release().catch(() => undefined)
    setRuntimeState('stopped')
    await bootLogEvent({ level: 'info', component: 'runtime', event: 'runtime_stopped' })
  }

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
      return relaunchRuntime()
    },
    health: runtimeHealth,
    restart: relaunchRuntime,
    stop,
    async disconnect() {
      await stop()
    },
  }
}

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
      const restartTimer = setTimeout(() => {
        void captureCurrentSessionSnapshot().finally(() => {
          app.relaunch()
          app.quit()
        })
      }, decision.delayMs)
      restartTimer.unref()
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
  const stop = () => clearInterval(timer)
  appState.runtimeSupervisorStop = stop
  return stop
}
