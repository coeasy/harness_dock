import { app, net, safeStorage } from 'electron'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  redactDiagnostics,
  type CredentialService,
  type DiagnosticsService,
  type DiagnosticsSnapshot,
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
  }
}

function diagnosticFileName(): string {
  return `harnessdock-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`
}

export function createElectronDiagnosticsService(network: NetworkService): DiagnosticsService {
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
