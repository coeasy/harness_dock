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

/** Resolve the URL Electron should navigate, preserving compatibility with pre-auth dsh. */
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

async function htmlResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType !== '' && !contentType.includes('text/html')) return false
  const html = await response.text()
  return /<!doctype\s+html|<html(?:\s|>)/i.test(html)
}

/**
 * Browser-faithful readiness probe. dsh 0.1.2+ exchanges the launch token for
 * an HttpOnly cookie with a 303 redirect; older dsh versions return HTML
 * directly. Never bypass the upstream authentication contract.
 */
export async function probeBrowserUrl(url: string, timeoutMs = 1_000): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const initial = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    if (await htmlResponse(initial)) return true
    if (initial.status !== 303) return false

    const location = initial.headers.get('location')
    const cookie = cookiePair(initial.headers.get('set-cookie'))
    if (!location || !cookie) return false

    const page = await fetch(new URL(location, url), {
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
