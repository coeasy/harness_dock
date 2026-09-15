interface AuthConnection {
  authenticatedUrl?: (baseUrl: string) => string
}

function readConnection(ctx: unknown): AuthConnection | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const root = ctx as Record<string, unknown>
  const get = root.get
  if (typeof get !== 'function') return undefined
  try {
    const value = get.call(ctx, 'connection')
    return value && typeof value === 'object' ? (value as AuthConnection) : undefined
  } catch {
    return undefined
  }
}

/** Resolve the URL the native host should navigate, preserving pre-auth dsh compatibility. */
export function browserUrlFor(ctx: unknown, baseUrl: string): string {
  const connection = readConnection(ctx)
  if (typeof connection?.authenticatedUrl !== 'function') return baseUrl
  try {
    return connection.authenticatedUrl(baseUrl)
  } catch {
    return baseUrl
  }
}

function cookiePair(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined
  const pair = setCookie.split(';', 1)[0]?.trim()
  return pair ? pair : undefined
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function safeBrowserUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) return null
    if (url.username || url.password || url.hash) return null
    return url
  } catch {
    return null
  }
}

function sameOriginLocation(location: string, base: URL): URL | null {
  try {
    const resolved = new URL(location, base)
    return resolved.origin === base.origin ? resolved : null
  } catch {
    return null
  }
}

async function htmlResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType !== '' && !contentType.includes('text/html')) return false
  const html = await response.text()
  return /<!doctype\s+html|<html(?:\s|>)/i.test(html)
}

/**
 * Browser-faithful readiness probe. dsh 0.1.2+ exchanges the process launch token for
 * an HttpOnly cookie with a 303 redirect; older dsh versions return HTML
 * directly. Never bypass the upstream authentication contract.
 */
export async function probeBrowserUrl(url: string, timeoutMs = 1_000): Promise<boolean> {
  const baseUrl = safeBrowserUrl(url)
  if (!baseUrl) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const initial = await fetch(baseUrl, { signal: controller.signal, redirect: 'manual' })
    if (await htmlResponse(initial)) return true
    if (initial.status !== 303) return false

    const location = initial.headers.get('location')
    const cookie = cookiePair(initial.headers.get('set-cookie'))
    if (!location || !cookie) return false

    const cleanUrl = sameOriginLocation(location, baseUrl)
    if (!cleanUrl) return false
    const page = await fetch(cleanUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { cookie },
    })
    return htmlResponse(page)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
