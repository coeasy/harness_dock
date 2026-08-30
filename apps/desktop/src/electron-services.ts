import { app, net, safeStorage, session } from 'electron'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdir, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  redactDiagnostics,
  type CredentialService,
  type DiagnosticsService,
  type DiagnosticsSnapshot,
  type LogService,
  type NetworkDiagnostic,
  type NetworkService,
  type NetworkState,
  type ProxyConfiguration,
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
import { refreshTray } from './tray.ts'

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

function validateFixedProxy(config: ProxyConfiguration): string {
  if (!config.host || !/^[a-z0-9._:[\]-]+$/i.test(config.host)) throw new Error('Invalid proxy host')
  if (!Number.isInteger(config.port) || !config.port || config.port < 1 || config.port > 65535) {
    throw new Error('Invalid proxy port')
  }
  const scheme = config.mode === 'socks5' ? 'socks5' : config.mode
  return `${scheme}://${config.host}:${config.port}`
}

export function createElectronNetworkService(
  credentials?: CredentialService,
  pollIntervalMs = 5_000,
): NetworkService {
  const listeners = new Set<(state: NetworkState) => void>()
  let timer: NodeJS.Timeout | undefined
  let previous = readNetworkState()
  let proxyCredentialKey: string | undefined
  appState.networkState = previous

  const publish = (next: NetworkState, force = false): void => {
    const changed = next !== previous
    previous = next
    appState.networkState = next
    if (appState.tray) refreshTray(appState.tray)
    if (!changed && !force) return
    for (const listener of listeners) listener(next)
  }

  if (credentials) {
    app.on('login', (event, _webContents, _request, authInfo, callback) => {
      if (!authInfo.isProxy || !proxyCredentialKey) return
      event.preventDefault()
      const prefix = proxyCredentialKey
      void Promise.all([
        credentials.get(`${prefix}.username`),
        credentials.get(`${prefix}.password`),
      ]).then(([username, password]) => {
        callback(username ?? '', password ?? '')
      }).catch(() => callback('', ''))
    })
  }

  const poll = (): void => publish(readNetworkState())

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
      publish(baseline === 'offline' ? 'offline' : 'limited')
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
        publish(classified.state)
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
      publish('online')
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
      publish(classified.state)
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
      publish(readNetworkState())
      return previous
    },
    subscribe(listener) {
      listeners.add(listener)
      syncTimer()
      queueMicrotask(() => listener(previous))
      return () => {
        listeners.delete(listener)
        syncTimer()
      }
    },
    diagnose,
    async configureProxy(config) {
      if (!app.isReady()) throw new Error('Electron app must be ready before configuring the proxy')
      proxyCredentialKey = config.credentialKey?.trim() || undefined
      const bypass = (config.bypassRules ?? [])
        .map((rule) => rule.trim())
        .filter(Boolean)
        .join(',')
      if (config.mode === 'system') {
        await session.defaultSession.setProxy({ mode: 'system' })
      } else if (config.mode === 'direct') {
        await session.defaultSession.setProxy({ mode: 'direct' })
      } else if (config.mode === 'pac') {
        const pac = config.pacUrl ? safeNetworkTarget(config.pacUrl) : ''
        if (!pac) throw new Error('PAC proxy mode requires pacUrl')
        await session.defaultSession.setProxy({ pacScript: pac, proxyBypassRules: bypass })
      } else {
        await session.defaultSession.setProxy({
          proxyRules: validateFixedProxy(config),
          proxyBypassRules: bypass,
        })
      }
      await session.defaultSession.forceReloadProxyConfig()
      publish(readNetworkState(), true)
      await bootLogEvent({
        level: 'info',
        component: 'network',
        event: 'proxy_configured',
        data: { mode: config.mode, credentialBacked: Boolean(proxyCredentialKey), bypassRuleCount: config.bypassRules?.length ?? 0 },
      })
    },
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
    const hostUpdateState = appState.hostUpdate ? await appState.hostUpdate.state('host').catch(() => null) : null
    const runtimeUpdateState = appState.updates ? await appState.updates.state('runtime').catch(() => null) : null
    const disk = await statfs(app.getPath('userData')).catch(() => null)
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
        runtimeState: appState.runtimeState,
        runtimeEndpoint: appState.runtimeEndpoint,
        managedRuntimeVersion: appState.managedRuntimeVersion,
        bundledRuntimeAvailable: appState.bundledAvailable,
        runtimeLease: appState.runtimeLease
          ? {
              ownerHost: appState.runtimeLease.record.ownerHost,
              ownerPid: appState.runtimeLease.record.ownerPid,
              runtimePid: appState.runtimeLease.record.runtimePid,
              runtimeId: appState.runtimeLease.record.runtimeId,
              endpoint: appState.runtimeLease.record.endpoint,
              dshVersion: appState.runtimeLease.record.dshVersion,
              protocolVersion: appState.runtimeLease.record.protocolVersion,
              updatedAt: appState.runtimeLease.record.updatedAt,
            }
          : null,
        gatewayActive: Boolean(appState.gateway),
        hostUpdateState,
        runtimeUpdateState,
        diskFreeBytes: disk ? disk.bavail * disk.bsize : undefined,
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
