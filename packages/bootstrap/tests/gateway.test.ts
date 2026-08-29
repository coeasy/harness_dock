import * as http from 'node:http'
import * as net from 'node:net'
import { describe, expect, it } from 'vitest'
import { startHarnessGateway, type HarnessGatewayHandle } from '../src/gateway.ts'

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

async function pairDevice(
  gateway: HarnessGatewayHandle,
  deviceName = 'test-phone',
): Promise<{ cookie: string; connectUrl: string }> {
  const ticket = gateway.createPairingTicket()
  const pair = await fetch(`${gateway.localUrl}api/harnessdock/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: ticket.code, deviceName }),
  })
  expect(pair.status).toBe(200)
  const body = (await pair.json()) as { connectUrl: string }
  const connect = await fetch(body.connectUrl, { redirect: 'manual' })
  expect(connect.status).toBe(302)
  const setCookie = connect.headers.get('set-cookie')
  expect(setCookie).toContain('HttpOnly')
  const cookie = setCookie?.split(';', 1)[0]
  if (!cookie) throw new Error('session cookie missing')
  return { cookie, connectUrl: body.connectUrl }
}

async function rawTcpRequest(baseUrl: string, request: string): Promise<string> {
  const target = new URL(baseUrl)
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = []
    const socket = net.connect(Number(target.port), target.hostname, () => socket.write(request))
    const timer = setTimeout(() => socket.destroy(new Error('raw TCP request timed out')), 5_000)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => {
      clearTimeout(timer)
      resolve(chunks.join(''))
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
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

  it('lists active devices and immediately revokes their sessions', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({ upstreamUrl: `http://127.0.0.1:${upstreamPort}/` })

    try {
      const phone = await pairDevice(gateway, 'Alice iPhone')
      const tablet = await pairDevice(gateway, 'Android Tablet')
      const devices = gateway.listDevices()
      expect(devices).toHaveLength(2)
      expect(devices.map((device) => device.name).sort()).toEqual(['Alice iPhone', 'Android Tablet'])

      const phoneDevice = devices.find((device) => device.name === 'Alice iPhone')
      if (!phoneDevice) throw new Error('paired phone missing from device registry')
      expect(gateway.revokeDevice(phoneDevice.id)).toBe(true)
      expect(gateway.revokeDevice(phoneDevice.id)).toBe(false)
      expect((await fetch(gateway.localUrl, { headers: { cookie: phone.cookie } })).status).toBe(401)
      expect((await fetch(gateway.localUrl, { headers: { cookie: tablet.cookie } })).status).toBe(200)
      expect(gateway.listDevices()).toHaveLength(1)

      expect(gateway.revokeAllDevices()).toBe(1)
      expect(gateway.listDevices()).toEqual([])
      expect((await fetch(gateway.localUrl, { headers: { cookie: tablet.cookie } })).status).toBe(401)
    } finally {
      await gateway.stop()
      await close(upstream)
    }
  })

  it('requires a gateway session for WebSocket upgrades and strips the gateway cookie upstream', async () => {
    let upstreamCookie: string | undefined
    const upstream = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    upstream.on('upgrade', (req, socket) => {
      upstreamCookie = req.headers.cookie
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.end('upstream-upgraded')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({ upstreamUrl: `http://127.0.0.1:${upstreamPort}/` })

    try {
      const unauthenticated = await rawTcpRequest(
        gateway.localUrl,
        'GET /stream HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      expect(unauthenticated).toContain('401 Unauthorized')

      const { cookie } = await pairDevice(gateway, 'streaming-phone')
      const authenticated = await rawTcpRequest(
        gateway.localUrl,
        `GET /stream HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
      )
      expect(authenticated).toContain('101 Switching Protocols')
      expect(authenticated).toContain('upstream-upgraded')
      expect(upstreamCookie).toBeUndefined()
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

  it('refuses a public gateway URL with a path prefix', async () => {
    await expect(
      startHarnessGateway({
        upstreamUrl: 'http://127.0.0.1:65534/',
        publicBaseUrl: 'https://gateway.example/harnessdock/',
      }),
    ).rejects.toThrow(/origin-root/)
  })
})
