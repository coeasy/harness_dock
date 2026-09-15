import { describe, expect, it } from 'vitest'
import { findListenAddress } from '../src/listen.ts'

describe('findListenAddress', () => {
  it('uses the published webServer port from dsh-host-webserver', () => {
    const ctx = {
      webServer: {
        host: '127.0.0.1',
        port: 41234,
      },
    }
    expect(findListenAddress(ctx)).toEqual({ host: '127.0.0.1', port: 41234 })
  })

  it('reads Node address() from the injected webServer service', () => {
    const ctx = {
      webServer: {
        server: {
          address: () => ({ address: '127.0.0.1', port: 41235, family: 'IPv4' }),
        },
      },
    }
    expect(findListenAddress(ctx)).toEqual({ host: '127.0.0.1', port: 41235 })
  })

  it('falls back to ctx.get("webServer") when not attached to ctx', () => {
    const server = { address: () => ({ address: '127.0.0.1', port: 42000, family: 'IPv4' }) }
    const ctx = {
      get: (name: string) => (name === 'webServer' ? { server } : undefined),
    }
    expect(findListenAddress(ctx)).toEqual({ host: '127.0.0.1', port: 42000 })
  })

  it('normalizes non-routable bind addresses to loopback', () => {
    expect(
      findListenAddress({
        webServer: { host: '0.0.0.0', port: 42001 },
      }),
    ).toEqual({ host: '127.0.0.1', port: 42001 })
    expect(
      findListenAddress({
        webServer: {
          server: {
            address: () => ({ address: '::ffff:127.0.0.1', port: 42002, family: 'IPv6' }),
          },
        },
      }),
    ).toEqual({ host: '127.0.0.1', port: 42002 })
  })

  it('tolerates ctx.get() throwing before injection', () => {
    const ctx = {
      get: () => {
        throw new Error('cannot get property "webServer" without inject')
      },
    }
    expect(findListenAddress(ctx)).toBeNull()
  })

  it('returns null when nothing is listening yet', () => {
    expect(findListenAddress({})).toBeNull()
    expect(
      findListenAddress({
        webServer: { server: { address: () => null } },
      }),
    ).toBeNull()
    expect(
      findListenAddress({
        webServer: { host: '127.0.0.1', port: 0 },
      }),
    ).toBeNull()
  })
})
