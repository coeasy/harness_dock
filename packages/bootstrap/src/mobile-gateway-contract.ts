export const HARNESS_GATEWAY_PROTOCOL_VERSION = 1 as const
export const HARNESS_GATEWAY_HEALTH_PATH = '/api/harnessdock/health' as const
export const HARNESS_GATEWAY_PAIR_PATH = '/api/harnessdock/pair' as const
export const HARNESS_GATEWAY_CONNECT_PATH = '/api/harnessdock/connect' as const

export interface HarnessGatewayHealthPayload {
  schemaVersion: typeof HARNESS_GATEWAY_PROTOCOL_VERSION
  ok: boolean
  provider: 'remote'
  appUrl?: string
  message?: string
}

export interface HarnessGatewayPairRequest {
  code: string
  deviceName: string
}

export interface HarnessGatewayPairResponse {
  connectUrl: string
  expiresAt: string
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

/** Public mobile gateways are HTTPS-only; loopback HTTP remains available for development. */
export function normalizeHarnessGatewayOrigin(value: string): URL {
  const url = new URL(value.trim())
  if (url.username || url.password) throw new Error('Gateway origin must not contain credentials.')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Gateway origin must not contain a path.')
  if (url.search || url.hash) throw new Error('Gateway origin must not contain query or fragment.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Remote HarnessDock gateways require HTTPS.')
  }
  url.pathname = '/'
  return url
}

export function assertGatewayConnectUrl(base: string | URL, connectUrl: string): URL {
  const origin = normalizeHarnessGatewayOrigin(typeof base === 'string' ? base : base.toString())
  const connect = new URL(connectUrl.trim())
  if (connect.origin !== origin.origin) throw new Error('Gateway connect URL changed origin; cross-origin handoff rejected.')
  if (connect.protocol !== 'https:' && !(connect.protocol === 'http:' && isLoopback(connect.hostname))) {
    throw new Error('Gateway connect URL is not secure.')
  }
  if (
    connect.username ||
    connect.password ||
    connect.pathname !== '/api/harnessdock/connect' ||
    connect.hash ||
    connect.searchParams.size !== 1 ||
    !connect.searchParams.get('token')
  ) {
    throw new Error('Gateway connect URL is not a valid one-time handoff URL.')
  }
  return connect
}

export function assertGatewayHealthPayload(
  base: string | URL,
  value: unknown,
): HarnessGatewayHealthPayload {
  const origin = normalizeHarnessGatewayOrigin(typeof base === 'string' ? base : base.toString())
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway health response is not an object.')
  }
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== HARNESS_GATEWAY_PROTOCOL_VERSION ||
    typeof record.ok !== 'boolean' ||
    record.provider !== 'remote'
  ) {
    throw new Error('Gateway health response does not match the supported contract.')
  }
  if (record.appUrl !== undefined) {
    if (typeof record.appUrl !== 'string') throw new Error('Gateway health appUrl is invalid.')
    const appUrl = normalizeHarnessGatewayOrigin(record.appUrl)
    if (appUrl.origin !== origin.origin) throw new Error('Gateway health appUrl changed origin.')
  }
  return {
    schemaVersion: HARNESS_GATEWAY_PROTOCOL_VERSION,
    ok: record.ok,
    provider: 'remote',
    ...(typeof record.appUrl === 'string' ? { appUrl: record.appUrl } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  }
}
