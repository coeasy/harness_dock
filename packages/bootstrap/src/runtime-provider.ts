import {
  normalizeReconnectPolicy,
  reconnectDelayMs,
  type ReconnectPolicy,
} from './network-policy.ts'

export type RuntimeProviderKind = 'local' | 'remote'

export interface RuntimeSession {
  provider: RuntimeProviderKind
  appUrl: string
  connectedAt: string
  dshVersion?: string
  runtimePid?: number
  metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface RuntimeHealth {
  ok: boolean
  provider: RuntimeProviderKind
  appUrl?: string
  dshVersion?: string
  message?: string
}

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind
  connect(): Promise<RuntimeSession>
  health(): Promise<RuntimeHealth>
  disconnect(): Promise<void>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type SleepLike = (delayMs: number, signal?: AbortSignal) => Promise<void>

export interface RemoteRuntimeProviderOptions {
  gatewayUrl: string
  pairingCode: string
  deviceName?: string
  fetchImpl?: FetchLike
  /** HTTP is accepted only for loopback development by default. */
  allowInsecureLocalhost?: boolean
}

export interface WaitForRemoteHealthOptions {
  policy?: Partial<ReconnectPolicy>
  signal?: AbortSignal
  sleepImpl?: SleepLike
  random?: () => number
}

interface PairResponse {
  connectUrl: string
  expiresAt: string
  dshVersion?: string
}

interface HealthResponse {
  ok?: boolean
  appUrl?: string
  dshVersion?: string
  message?: string
}

export class RemoteRuntimeReconnectError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastHealth: RuntimeHealth,
  ) {
    super(`Remote runtime did not recover after ${attempts} health checks${lastHealth.message ? `: ${lastHealth.message}` : ''}`)
    this.name = 'RemoteRuntimeReconnectError'
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

export function normalizeRemoteGatewayUrl(
  value: string,
  options: { allowInsecureLocalhost?: boolean } = {},
): URL {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:') {
    const allowLocal = options.allowInsecureLocalhost !== false && url.protocol === 'http:' && isLoopback(url.hostname)
    if (!allowLocal) {
      throw new Error('HarnessDock remote gateways must use HTTPS (HTTP is allowed only for loopback development).')
    }
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}

function assertPairResponse(value: unknown, gateway: URL): PairResponse {
  if (!value || typeof value !== 'object') throw new Error('Gateway returned an invalid pairing response.')
  const record = value as Record<string, unknown>
  if (typeof record.connectUrl !== 'string' || typeof record.expiresAt !== 'string') {
    throw new Error('Gateway pairing response is missing connectUrl/expiresAt.')
  }
  const connectUrl = new URL(record.connectUrl)
  if (connectUrl.origin !== gateway.origin) {
    throw new Error(`Gateway returned a cross-origin connect URL (${connectUrl.origin}).`)
  }
  return {
    connectUrl: connectUrl.toString(),
    expiresAt: record.expiresAt,
    ...(typeof record.dshVersion === 'string' ? { dshVersion: record.dshVersion } : {}),
  }
}

function abortError(): Error {
  const error = new Error('Remote runtime reconnect aborted')
  error.name = 'AbortError'
  return error
}

export const sleepWithAbort: SleepLike = async (delayMs, signal) => {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, delayMs))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Remote provider used by iOS/Android. It does not spawn, download, or execute
 * dsh. Pairing happens over HTTPS and returns a one-time WebView connect URL;
 * the gateway turns that URL into an HttpOnly session cookie before serving
 * the official Harness Web UI.
 */
export class RemoteRuntimeProvider implements RuntimeProvider {
  readonly kind = 'remote' as const
  readonly gateway: URL
  private readonly fetchImpl: FetchLike
  private readonly pairingCode: string
  private readonly deviceName: string
  private session: RuntimeSession | undefined

  constructor(options: RemoteRuntimeProviderOptions) {
    this.gateway = normalizeRemoteGatewayUrl(options.gatewayUrl, {
      allowInsecureLocalhost: options.allowInsecureLocalhost,
    })
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.pairingCode = options.pairingCode.trim()
    this.deviceName = options.deviceName?.trim() || 'HarnessDock Mobile'
    if (!this.pairingCode) throw new Error('A pairing code is required.')
  }

  async connect(): Promise<RuntimeSession> {
    const endpoint = new URL('api/harnessdock/pair', this.gateway)
    const response = await this.fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: this.pairingCode, deviceName: this.deviceName }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Gateway pairing failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    const pair = assertPairResponse(await response.json(), this.gateway)
    this.session = {
      provider: 'remote',
      appUrl: pair.connectUrl,
      connectedAt: new Date().toISOString(),
      ...(pair.dshVersion ? { dshVersion: pair.dshVersion } : {}),
      metadata: { pairingExpiresAt: pair.expiresAt },
    }
    return this.session
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const endpoint = new URL('api/harnessdock/health', this.gateway)
      const response = await this.fetchImpl(endpoint.toString(), { headers: { accept: 'application/json' } })
      if (!response.ok) {
        return { ok: false, provider: 'remote', message: `Gateway health returned ${response.status}.` }
      }
      const body = (await response.json()) as HealthResponse
      return {
        ok: body.ok !== false,
        provider: 'remote',
        ...(typeof body.appUrl === 'string' ? { appUrl: body.appUrl } : {}),
        ...(typeof body.dshVersion === 'string' ? { dshVersion: body.dshVersion } : {}),
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'remote',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Wait for an already-paired gateway/runtime to become healthy again using
   * bounded exponential backoff. This deliberately NEVER calls connect() and
   * therefore never reuses a one-time pairing code. Restoring an authenticated
   * WebView session after cookie expiry requires the future device-credential
   * flow rather than unsafe automatic re-pairing.
   */
  async waitUntilHealthy(options: WaitForRemoteHealthOptions = {}): Promise<RuntimeHealth> {
    const policy = normalizeReconnectPolicy(options.policy)
    const sleep = options.sleepImpl ?? sleepWithAbort
    const random = options.random ?? Math.random
    let attempts = 0
    let lastHealth: RuntimeHealth = { ok: false, provider: 'remote', message: 'not checked' }

    for (;;) {
      if (options.signal?.aborted) throw abortError()
      attempts += 1
      lastHealth = await this.health()
      if (lastHealth.ok) return lastHealth
      if (policy.maxAttempts !== undefined && attempts >= policy.maxAttempts) {
        throw new RemoteRuntimeReconnectError(attempts, lastHealth)
      }
      const delay = reconnectDelayMs(attempts - 1, policy, random)
      await sleep(delay, options.signal)
    }
  }

  async disconnect(): Promise<void> {
    this.session = undefined
  }
}
