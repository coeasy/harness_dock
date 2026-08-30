import { describe, expect, it, vi } from 'vitest'
import {
  RemoteRuntimeProvider,
  RemoteRuntimeReconnectError,
  normalizeRemoteGatewayUrl,
} from '../src/runtime-provider.ts'

describe('RemoteRuntimeProvider', () => {
  it('requires HTTPS outside loopback development', () => {
    expect(() => normalizeRemoteGatewayUrl('http://example.com')).toThrow(/HTTPS/)
    expect(normalizeRemoteGatewayUrl('http://127.0.0.1:8080').toString()).toBe('http://127.0.0.1:8080/')
  })

  it('pairs through the gateway and returns a one-time WebView URL', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/api/harnessdock/pair')) {
        return new Response(
          JSON.stringify({
            connectUrl: 'https://gateway.example/api/harnessdock/connect?token=one-time',
            expiresAt: '2026-08-30T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true, appUrl: 'https://gateway.example/' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const provider = new RemoteRuntimeProvider({
      gatewayUrl: 'https://gateway.example',
      pairingCode: '1234-5678',
      fetchImpl,
    })
    const session = await provider.connect()
    expect(session.provider).toBe('remote')
    expect(session.appUrl).toContain('/api/harnessdock/connect?token=')
    expect((await provider.health()).ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects a gateway that tries to hand off the WebView to another origin', async () => {
    const provider = new RemoteRuntimeProvider({
      gatewayUrl: 'https://gateway.example',
      pairingCode: '12345678',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ connectUrl: 'https://evil.example/connect', expiresAt: new Date().toISOString() }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })
    await expect(provider.connect()).rejects.toThrow(/cross-origin/)
  })

  it('waits for an already-paired gateway to become healthy without reusing the pairing code', async () => {
    let healthCalls = 0
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/api/harnessdock/pair')) {
        throw new Error('waitUntilHealthy must never re-pair')
      }
      healthCalls += 1
      return new Response(JSON.stringify({ ok: healthCalls >= 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const sleeps: number[] = []
    const provider = new RemoteRuntimeProvider({
      gatewayUrl: 'https://gateway.example',
      pairingCode: '12345678',
      fetchImpl,
    })
    const health = await provider.waitUntilHealthy({
      policy: {
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        multiplier: 2,
        jitterRatio: 0,
        maxAttempts: 4,
      },
      random: () => 0.5,
      sleepImpl: async (delay) => {
        sleeps.push(delay)
      },
    })
    expect(health.ok).toBe(true)
    expect(healthCalls).toBe(3)
    expect(sleeps).toEqual([100, 200])
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith('/api/harnessdock/health'))).toBe(true)
  })

  it('fails bounded reconnect after max health checks and supports abort', async () => {
    const provider = new RemoteRuntimeProvider({
      gatewayUrl: 'https://gateway.example',
      pairingCode: '12345678',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, message: 'runtime unavailable' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    await expect(
      provider.waitUntilHealthy({
        policy: { initialDelayMs: 0, maxDelayMs: 0, multiplier: 1, jitterRatio: 0, maxAttempts: 2 },
        sleepImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'RemoteRuntimeReconnectError', attempts: 2 } satisfies Partial<RemoteRuntimeReconnectError>)

    const controller = new AbortController()
    controller.abort()
    await expect(provider.waitUntilHealthy({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
