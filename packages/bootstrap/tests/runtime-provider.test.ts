import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeProvider, normalizeRemoteGatewayUrl } from '../src/runtime-provider.ts'

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
})
