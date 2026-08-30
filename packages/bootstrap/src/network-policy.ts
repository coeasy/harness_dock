export type NetworkProxyPolicy =
  | { mode: 'system' }
  | { mode: 'direct' }
  | {
      mode: 'http' | 'https' | 'socks5'
      endpoint: string
      bypass?: readonly string[]
    }

export class InvalidNetworkProxyPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNetworkProxyPolicyError'
  }
}

function normalizeBypass(value: readonly string[] | undefined): string[] | undefined {
  if (!value?.length) return undefined
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const item = raw.trim()
    if (!item || item.length > 200 || /[\r\n;,]/.test(item)) {
      throw new InvalidNetworkProxyPolicyError('Proxy bypass entries must be non-empty and cannot contain CR/LF/semicolon/comma')
    }
    if (!seen.has(item)) {
      seen.add(item)
      normalized.push(item)
    }
  }
  return normalized.length ? normalized : undefined
}

export function normalizeNetworkProxyPolicy(input: NetworkProxyPolicy): NetworkProxyPolicy {
  if (!input || typeof input !== 'object') {
    throw new InvalidNetworkProxyPolicyError('Proxy policy must be an object')
  }
  if (input.mode === 'system' || input.mode === 'direct') return { mode: input.mode }
  if (input.mode !== 'http' && input.mode !== 'https' && input.mode !== 'socks5') {
    throw new InvalidNetworkProxyPolicyError('Unsupported proxy policy mode')
  }

  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint.trim())
  } catch {
    throw new InvalidNetworkProxyPolicyError('Proxy endpoint must be a valid URL')
  }
  if (endpoint.protocol !== `${input.mode}:`) {
    throw new InvalidNetworkProxyPolicyError(`Proxy endpoint protocol must be ${input.mode}://`)
  }
  if (endpoint.username || endpoint.password) {
    throw new InvalidNetworkProxyPolicyError('Proxy credentials must not be stored in network policy')
  }
  // WHATWG URL treats http(s) as special schemes (pathname "/") while
  // socks5 is non-special (pathname ""). Both forms mean "no endpoint path".
  if (
    !endpoint.hostname ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new InvalidNetworkProxyPolicyError('Proxy endpoint must contain only scheme, host and optional port')
  }
  if (endpoint.port) {
    const port = Number(endpoint.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InvalidNetworkProxyPolicyError('Proxy endpoint port is invalid')
    }
  }

  const bypass = normalizeBypass(input.bypass)
  return {
    mode: input.mode,
    endpoint: endpoint.toString(),
    ...(bypass ? { bypass } : {}),
  }
}

export function defaultNetworkProxyPolicy(): NetworkProxyPolicy {
  return { mode: 'system' }
}

export interface ReconnectPolicy {
  initialDelayMs: number
  maxDelayMs: number
  multiplier: number
  jitterRatio: number
  maxAttempts?: number
}

export const DEFAULT_RECONNECT_POLICY: Readonly<ReconnectPolicy> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
}

export function normalizeReconnectPolicy(
  input: Partial<ReconnectPolicy> = {},
): ReconnectPolicy {
  const value: ReconnectPolicy = {
    initialDelayMs: input.initialDelayMs ?? DEFAULT_RECONNECT_POLICY.initialDelayMs,
    maxDelayMs: input.maxDelayMs ?? DEFAULT_RECONNECT_POLICY.maxDelayMs,
    multiplier: input.multiplier ?? DEFAULT_RECONNECT_POLICY.multiplier,
    jitterRatio: input.jitterRatio ?? DEFAULT_RECONNECT_POLICY.jitterRatio,
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
  }
  if (!Number.isFinite(value.initialDelayMs) || value.initialDelayMs < 0) {
    throw new Error('Reconnect initialDelayMs must be >= 0')
  }
  if (!Number.isFinite(value.maxDelayMs) || value.maxDelayMs < value.initialDelayMs) {
    throw new Error('Reconnect maxDelayMs must be >= initialDelayMs')
  }
  if (!Number.isFinite(value.multiplier) || value.multiplier < 1) {
    throw new Error('Reconnect multiplier must be >= 1')
  }
  if (!Number.isFinite(value.jitterRatio) || value.jitterRatio < 0 || value.jitterRatio > 1) {
    throw new Error('Reconnect jitterRatio must be between 0 and 1')
  }
  if (
    value.maxAttempts !== undefined &&
    (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1)
  ) {
    throw new Error('Reconnect maxAttempts must be a positive integer')
  }
  return value
}

export function reconnectDelayMs(
  attempt: number,
  policy: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY },
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Reconnect attempt must be a non-negative integer')
  const normalized = normalizeReconnectPolicy(policy)
  const exponential = Math.min(
    normalized.maxDelayMs,
    normalized.initialDelayMs * normalized.multiplier ** attempt,
  )
  const span = exponential * normalized.jitterRatio
  const unit = Math.max(0, Math.min(1, random()))
  const jitter = span === 0 ? 0 : (unit * 2 - 1) * span
  return Math.max(0, Math.round(exponential + jitter))
}
