import { describe, expect, it } from 'vitest'
import { recoveryRouteFromUrl, recoveryUrlForRoute } from '../src/client-session-route.ts'

describe('session recovery route sanitization', () => {
  const origin = 'http://127.0.0.1:43123'

  it('keeps same-origin pathname/hash while dropping all query parameters', () => {
    expect(
      recoveryRouteFromUrl(
        `${origin}/sessions/abc?token=launch-secret&view=full#messages`,
        origin,
      ),
    ).toBe('/sessions/abc#messages')
  })

  it('drops secret-bearing hash fragments rather than persisting OAuth/token data', () => {
    expect(recoveryRouteFromUrl(`${origin}/auth#access_token=secret`, origin)).toBe('/auth')
    expect(recoveryRouteFromUrl(`${origin}/callback#code=oauth-code`, origin)).toBe('/callback')
  })

  it('rejects cross-origin and protocol-relative recovery routes', () => {
    expect(recoveryRouteFromUrl('https://evil.example/session/1', origin)).toBeNull()
    expect(recoveryUrlForRoute('//evil.example/session/1', origin)).toBeNull()
  })

  it('restores only query-free routes into the authenticated local origin', () => {
    expect(recoveryUrlForRoute('/sessions/abc#messages', origin)).toBe(
      `${origin}/sessions/abc#messages`,
    )
    expect(recoveryUrlForRoute('/sessions/abc?token=secret', origin)).toBeNull()
  })
})
