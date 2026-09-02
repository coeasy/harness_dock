export interface WebUiSession {
  url: string
  cookie?: string
}

export interface WebUiProbeOptions {
  timeoutMs?: number
  requireHtml?: boolean
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

function safeWebUrl(value: string): URL | null {
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

async function responseLooksReady(response: Response, requireHtml: boolean): Promise<boolean> {
  if (!response.ok) return false
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType !== '' && !contentType.includes('text/html')) return false
  const body = await response.text()
  if (body.trim().length === 0) return false
  return !requireHtml || /<!doctype\s+html|<html(?:\s|>)/i.test(body)
}

/**
 * Open the dsh Web URL the same way a browser does.
 *
 * dsh <= 0.1.1 serves the loopback index directly. dsh 0.1.2+ protects the
 * index with a reusable process launch token: GET /?token=... returns 303 + Set-Cookie,
 * then the browser follows the clean / URL with that cookie. Supporting both
 * flows keeps old runtimes compatible while preserving the authenticated URL
 * that the native host must navigate for newer runtimes.
 */
export async function openWebUiSession(
  url: string,
  options: WebUiProbeOptions = {},
): Promise<WebUiSession | null> {
  const baseUrl = safeWebUrl(url)
  if (!baseUrl) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000)
  const requireHtml = options.requireHtml ?? false
  try {
    const initial = await fetch(baseUrl, {
      signal: controller.signal,
      redirect: 'manual',
    })
    if (await responseLooksReady(initial, requireHtml)) return { url }
    if (initial.status !== 303) return null

    const location = initial.headers.get('location')
    const cookie = cookiePair(initial.headers.get('set-cookie'))
    if (!location || !cookie) return null

    const cleanUrl = sameOriginLocation(location, baseUrl)
    if (!cleanUrl) return null
    const page = await fetch(cleanUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { cookie },
    })
    if (!(await responseLooksReady(page, requireHtml))) return null
    return { url: cleanUrl.href, cookie }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Re-probe an already authenticated Web session without exposing its cookie. */
export async function probeWebUiSession(
  session: WebUiSession,
  options: WebUiProbeOptions = {},
): Promise<boolean> {
  const sessionUrl = safeWebUrl(session.url)
  if (!sessionUrl) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_000)
  try {
    const response = await fetch(sessionUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: session.cookie ? { cookie: session.cookie } : undefined,
    })
    return responseLooksReady(response, options.requireHtml ?? false)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
