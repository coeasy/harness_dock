const QUERY_SECRET = /([?&](?:access[_-]?token|auth|authorization|code|credential|password|secret|token|api[_-]?key)=)([^&#\s]+)/gi
const ASSIGNMENT_SECRET = /\b((?:access[_-]?token|authorization|credential|password|secret|token|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi
const BEARER_SECRET = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi

export function redactLogText(input: string): string {
  return input
    .replace(QUERY_SECRET, '$1[REDACTED]')
    .replace(ASSIGNMENT_SECRET, '$1[REDACTED]')
    .replace(BEARER_SECRET, '$1[REDACTED]')
}

export function safeNetworkTarget(input: string): string {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('Network diagnostic target must be a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Network diagnostic target must use http or https')
  }
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

export function proxyModeFromRules(rules: string): 'direct' | 'proxy' | 'pac' | 'unknown' {
  const normalized = rules.trim().toUpperCase()
  if (!normalized) return 'unknown'
  if (normalized.split(';').every((part) => part.trim() === 'DIRECT')) return 'direct'
  if (/\b(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\b/.test(normalized)) return 'proxy'
  if (/\bPAC\b/.test(normalized)) return 'pac'
  return normalized.includes('DIRECT') ? 'direct' : 'unknown'
}

export function networkStateFromError(error: unknown): {
  state: 'offline' | 'proxy-error' | 'dns-error' | 'tls-error' | 'limited'
  errorCode?: string
} {
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown }
  const nested = candidate?.cause as { code?: unknown; message?: unknown } | undefined
  const code =
    (typeof candidate?.code === 'string' ? candidate.code : undefined) ??
    (typeof nested?.code === 'string' ? nested.code : undefined)
  const message = [candidate?.message, nested?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const signal = `${code ?? ''} ${message}`.toUpperCase()

  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH|ENETDOWN/.test(signal)) {
    return { state: 'offline', ...(code ? { errorCode: code } : {}) }
  }
  if (/ERR_PROXY|PROXY_CONNECTION|TUNNEL_CONNECTION/.test(signal)) {
    return { state: 'proxy-error', ...(code ? { errorCode: code } : {}) }
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|DNS/.test(signal)) {
    return { state: 'dns-error', ...(code ? { errorCode: code } : {}) }
  }
  if (/ERR_CERT|ERR_SSL|CERTIFICATE|TLS|SSL/.test(signal)) {
    return { state: 'tls-error', ...(code ? { errorCode: code } : {}) }
  }
  return { state: 'limited', ...(code ? { errorCode: code } : {}) }
}
