export type RuntimeProviderKind = 'local' | 'remote'

/**
 * Host-private upstream authentication context. This value must never be
 * rendered, logged, persisted to client-visible state, or sent to mobile
 * callers. It exists only so a trusted Gateway host can authenticate to dsh.
 */
export interface RuntimeUpstreamSession {
  url: string
  cookie?: string
}

export interface RuntimeSession {
  provider: RuntimeProviderKind
  appUrl: string
  connectedAt: string
  dshVersion?: string
  runtimePid?: number
  upstream?: RuntimeUpstreamSession
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

export interface RemoteRuntimeProviderOptions {
  gatewayUrl: string
  pairingCode: string
  deviceName?: string
  fetchImpl?: FetchLike
  /** HTTP is accepted only for loopback development by default. */
  allowInsecureLocalhost?: boolean
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

  async disconnect(): Promise<void> {
    this.session = undefined
  }
}
