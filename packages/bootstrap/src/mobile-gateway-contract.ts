export const HARNESS_GATEWAY_PROTOCOL_VERSION = 1 as const
export const HARNESS_GATEWAY_HEALTH_PATH = '/api/harnessdock/health' as const
export const HARNESS_GATEWAY_PAIR_PATH = '/api/harnessdock/pair' as const
export const HARNESS_GATEWAY_CONNECT_PATH = '/api/harnessdock/connect' as const

export interface HarnessGatewayHealthPayload {
  schemaVersion: typeof HARNESS_GATEWAY_PROTOCOL_VERSION
  ok: boolean
  provider: 'remote'
  appUrl?: string
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
  const origin = typeof base === 'string' ? normalizeHarnessGatewayOrigin(base) : base
  const connect = new URL(connectUrl)
  if (connect.origin !== origin.origin) throw new Error('Gateway connect URL changed origin.')
  if (connect.protocol !== 'https:' && !(connect.protocol === 'http:' && isLoopback(connect.hostname))) {
    throw new Error('Gateway connect URL is not secure.')
  }
  return connect
}
