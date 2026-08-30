import { app, net, safeStorage, session } from 'electron'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeNetworkProxyPolicy,
  redactDiagnostics,
  type CredentialService,
  type DiagnosticsService,
  type DiagnosticsSnapshot,
  type LogService,
  type NetworkDiagnostic,
  type NetworkPolicyService,
  type NetworkProxyPolicy,
  type NetworkService,
  type NetworkState,
  type SessionRecoveryService,
} from '@dsh/bootstrap/client-core'
import { appState } from './state.ts'
import {
  EncryptedCredentialFileStore,
  JsonSessionRecoveryService,
  type SecretCodec,
} from './client-persistence.ts'
import { bootLogEvent, recentLogEvents } from './boot-log.ts'
import {
  networkStateFromError,
  proxyModeFromRules,
  safeNetworkTarget,
} from './log-redaction.ts'
import {
  JsonNetworkPolicyStore,
  electronProxyConfigFromPolicy,
} from './network-policy-store.ts'

const gzipAsync = promisify(gzip)

export class SecureStorageUnavailableError extends Error {
  constructor(readonly reason = 'unavailable') {
    super(`OS-backed secure storage is ${reason}; refusing to persist credentials in plaintext`)
    this.name = 'SecureStorageUnavailableError'
  }
}

function credentialFile(): string {
  return path.join(app.getPath('userData'), 'secure', 'credentials.v1.json')
}

function recoveryFile(): string {
  return path.join(app.getPath('userData'), 'client-state', 'session.v1.json')
}

function networkPolicyFile(): string {
  return path.join(app.getPath('userData'), 'client-state', 'network-policy.v1.json')
}

function safeStorageCodec(): SecretCodec {
  const ensureAvailable = (): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new SecureStorageUnavailableError()
    if (process.platform === 'linux') {
      const compatibleStorage = safeStorage as typeof safeStorage & {
        getSelectedStorageBackend?: () => string
      }
      const backend = compatibleStorage.getSelectedStorageBackend?.()
      if (backend === 'basic_text') {
        throw new SecureStorageUnavailableError('using insecure Linux basic_text backend')
      }
    }
  }
  return {
    encrypt(value: string) {
      ensureAvailable()
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value: string) {
      ensureAvailable()
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    },
  }
}

export function createElectronCredentialService(): CredentialService {
  return new EncryptedCredentialFileStore(credentialFile(), safeStorageCodec())
}

export function createElectronSessionRecoveryService(): SessionRecoveryService {
  return new JsonSessionRecoveryService(recoveryFile())
}

export function createElectronLogService(): LogService {
  return {
    write: bootLogEvent,
    recent: recentLogEvents,
  }
}

async function applyProxyPolicyToSession(policy: NetworkProxyPolicy): Promise<NetworkProxyPolicy> {
  if (!app.isReady()) throw new Error('Electron must be ready before applying network policy')
  const normalized = normalizeNetworkProxyPolicy(policy)
  await session.defaultSession.setProxy(electronProxyConfigFromPolicy(normalized))
  const compatibleSession = session.defaultSession as typeof session.defaultSession & {
    closeAllConnections?: () => Promise<void>
  }
  await compatibleSession.closeAllConnections?.().catch(() => undefined)
  return normalized
}

export function createElectronNetworkPolicyService(logs: LogService): NetworkPolicyService {
  const store = new JsonNetworkPolicyStore(networkPolicyFile())
  const applyAndLog = async (
    policy: NetworkProxyPolicy,
    event: 'applied' | 'restored' | 'reset',
    persist: boolean,
  ): Promise<NetworkProxyPolicy> => {
    const normalized = await applyProxyPolicyToSession(policy)
    if (persist) await store.save(normalized)
    await logs.write({
      level: 'info',
      component: 'network-policy',
      event,
      data: {
        mode: normalized.mode,
        bypassCount: 'bypass' in normalized ? (normalized.bypass?.length ?? 0) : 0,
      },
    })
    return normalized
  }

  return {
    current: () => store.load(),
    apply: (policy) => applyAndLog(policy, 'applied', true),
    async reset() {
      const normalized = await applyAndLog({ mode: 'system' }, 'reset', false)
      await store.reset()
      return normalized
    },
    async restore() {
      const stored = await store.load()
      return applyAndLog(stored, 'restored', false)
    },
  }
}

function readNetworkState(): NetworkState {
  if (!app.isReady()) return 'limited'
  const compatibleNet = net as typeof net & {
    isOnline?: () => boolean
    online?: boolean
  }
  try {
    if (typeof compatibleNet.isOnline === 'function') {
      return compatibleNet.isOnline() ? 'online' : 'offline'
    }
    if (typeof compatibleNet.online === 'boolean') {
      return compatibleNet.online ? 'online' : 'offline'
    }
  } catch {
    return 'limited'
  }
  return 'limited'
}

export function createElectronNetworkService(pollIntervalMs = 5_000): NetworkService {
  const listeners = new Set<(state: NetworkState) => void>()
  let timer: NodeJS.Timeout | undefined
  let previous = readNetworkState()

  const poll = (): void => {
    const next = readNetworkState()
    if (next === previous) return
    previous = next
    for (const listener of listeners) listener(next)
  }

  const syncTimer = (): void => {
    if (listeners.size > 0 && !timer) {
      timer = setInterval(poll, pollIntervalMs)
      timer.unref()
      return
    }
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const diagnose = async (target: string, timeoutMs = 10_000): Promise<NetworkDiagnostic> => {
    const safeTarget = safeNetworkTarget(target)
    const checkedAt = new Date().toISOString()
    const baseline = readNetworkState()
    if (!app.isReady() || baseline === 'offline') {
      return {
        target: safeTarget,
        state: baseline === 'offline' ? 'offline' : 'limited',
        reachable: false,
        proxyMode: 'unknown',
        checkedAt,
      }
    }

    let proxyMode: NetworkDiagnostic['proxyMode'] = 'unknown'
    try {
      proxyMode = proxyModeFromRules(await session.defaultSession.resolveProxy(safeTarget))
    } catch (error) {
      const classified = networkStateFromError(error)
      if (classified.state === 'proxy-error') {
        return {
          target: safeTarget,
          state: classified.state,
          reachable: false,
          proxyMode,
          ...(classified.errorCode ? { errorCode: classified.errorCode } : {}),
          checkedAt,
        }
      }
    }

    const boundedTimeout = Math.max(1_000, Math.min(60_000, Math.floor(timeoutMs)))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), boundedTimeout)
    timeout.unref()
    const started = Date.now()
    try {
      const response = await net.fetch(safeTarget, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      })
      return {
        target: safeTarget,
        state: 'online',
        reachable: true,
        proxyMode,
        latencyMs: Date.now() - started,
        httpStatus: response.status,
        checkedAt,
      }
    } catch (error) {
      const classified = networkStateFromError(error)
      return {
        target: safeTarget,
        state: classified.state,
        reachable: false,
        proxyMode,
        latencyMs: Date.now() - started,
        ...(classified.errorCode ? { errorCode: classified.errorCode } : {}),
        checkedAt,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async state() {
      previous = readNetworkState()
      return previous
    },
    subscribe(listener) {
      listeners.add(listener)
      syncTimer()
      queueMicrotask(() => listener(readNetworkState()))
      return () => {
        listeners.delete(listener)
        syncTimer()
      }
    },
    diagnose,
  }
}

function diagnosticFileName(): string {
  return `harnessdock-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`
}

export function createElectronDiagnosticsService(
  network: NetworkService,
  logs: LogService,
): DiagnosticsService {
  const collect = async (): Promise<DiagnosticsSnapshot> => {
    const networkState = await network.state()
    const snapshot: DiagnosticsSnapshot = {
      generatedAt: new Date().toISOString(),
      host: 'electron',
      hostVersion: app.getVersion(),
      runtimeVersion: appState.dshVersion,
      runtimePid: appState.dshPid,
      platform: process.platform,
      arch: process.arch,
      networkState,
      data: {
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        runtimeMode: appState.mode,
        bundledRuntimeAvailable: appState.bundledAvailable,
        runtimeLease: appState.runtimeLease
          ? {
              host: appState.runtimeLease.record.host,
              hostPid: appState.runtimeLease.record.hostPid,
              runtimePid: appState.runtimeLease.record.runtimePid,
              runtimeId: appState.runtimeLease.record.runtimeId,
              dshVersion: appState.runtimeLease.record.dshVersion,
              protocolVersion: appState.runtimeLease.record.protocolVersion,
            }
          : null,
        gatewayActive: Boolean(appState.gateway),
        recentEvents: await logs.recent(100),
      },
    }
    return redactDiagnostics(snapshot)
  }

  return {
    collect,
    async exportBundle(destination?: string) {
      const file = destination ?? path.join(app.getPath('downloads'), diagnosticFileName())
      await mkdir(path.dirname(file), { recursive: true })
      const snapshot = await collect()
      const compressed = await gzipAsync(Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'))
      await writeFile(file, compressed, { mode: 0o600 })
      return file
    },
  }
}
