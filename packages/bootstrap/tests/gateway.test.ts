import * as http from 'node:http'
import { describe, expect, it } from 'vitest'
import { startHarnessGateway } from '../src/gateway.ts'

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return address.port
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('HarnessGateway', () => {
  it('uses single-use pairing and an HttpOnly session before proxying Harness', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('upstream-ok')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({ upstreamUrl: `http://127.0.0.1:${upstreamPort}/` })

    try {
      const ticket = gateway.createPairingTicket()
      const pair = await fetch(`${gateway.localUrl}api/harnessdock/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: ticket.code, deviceName: 'test-phone' }),
      })
      expect(pair.status).toBe(200)
      const body = (await pair.json()) as { connectUrl: string }

      const replay = await fetch(`${gateway.localUrl}api/harnessdock/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: ticket.code, deviceName: 'replay' }),
      })
      expect(replay.status).toBe(401)

      const connect = await fetch(body.connectUrl, { redirect: 'manual' })
      expect(connect.status).toBe(302)
      const setCookie = connect.headers.get('set-cookie')
      expect(setCookie).toContain('HttpOnly')
      const cookie = setCookie?.split(';', 1)[0]
      if (!cookie) throw new Error('session cookie missing')

      const proxied = await fetch(gateway.localUrl, { headers: { cookie } })
      expect(proxied.status).toBe(200)
      expect(await proxied.text()).toBe('upstream-ok')
    } finally {
      await gateway.stop()
      await close(upstream)
    }
  })

  it('refuses an insecure non-loopback public URL by default', async () => {
    await expect(
      startHarnessGateway({
        upstreamUrl: 'http://127.0.0.1:65534/',
        publicBaseUrl: 'http://192.0.2.10:8080/',
      }),
    ).rejects.toThrow(/HTTPS/)
  })
})
