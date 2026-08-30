const SENSITIVE_FRAGMENT = /(?:access[_-]?token|auth|authorization|code|credential|password|secret|token|api[_-]?key)=/i

/**
 * Convert a live WebView URL into a persistence-safe route. Query strings are
 * intentionally dropped so dsh launch tokens, OAuth codes and provider query
 * credentials can never enter the recovery file. Hash routes are retained only
 * when they do not look like secret-bearing fragments.
 */
export function recoveryRouteFromUrl(input: string, allowedOrigin: string): string | null {
  try {
    const url = new URL(input)
    if (url.origin !== allowedOrigin) return null
    const pathname = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`
    const hash = url.hash && !SENSITIVE_FRAGMENT.test(url.hash) ? url.hash : ''
    const route = `${pathname}${hash}`
    if (route.length > 4096) return null
    return route
  } catch {
    return null
  }
}

/** Resolve a persisted route back into the already-authenticated dsh origin. */
export function recoveryUrlForRoute(route: string, allowedOrigin: string): string | null {
  if (!route || route.length > 4096 || route.includes('?')) return null
  try {
    const target = new URL(route, `${allowedOrigin}/`)
    if (target.origin !== allowedOrigin) return null
    return target.toString()
  } catch {
    return null
  }
}
