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
    socket.on('data', (chunk) => chunks.push(String(chunk)))
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
  it('rejects a non-loopback Harness Web upstream before binding', async () => {
    await expect(
      startHarnessGateway({ upstreamUrl: 'https://harness.example/' }),
    ).rejects.toThrow(/loopback/)
  })

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

      const malformedConnect = await fetch(`${body.connectUrl}&token=duplicate`, { redirect: 'manual' })
      expect(malformedConnect.status).toBe(400)

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

  it('keeps the dsh browser-auth cookie host-private and authoritative for HTTP proxying', async () => {
    const seen: string[] = []
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers.cookie ?? '')
      if (!req.headers.cookie?.includes('dsh-auth-test=server-secret')) {
        res.writeHead(401)
        res.end('missing-auth')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('authenticated')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/`,
      upstreamCookie: 'dsh-auth-test=server-secret',
    })

    try {
      const { cookie } = await pairDevice(gateway, 'authenticated-phone')
      const response = await fetch(gateway.localUrl, {
        headers: { cookie: `${cookie}; dsh-auth-test=client-forgery; client-pref=ok` },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('authenticated')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain('dsh-auth-test=server-secret')
      expect(seen[0]).toContain('client-pref=ok')
      expect(seen[0]).not.toContain('client-forgery')
      expect(seen[0]).not.toContain('harnessdock_session')
    } finally {
      await gateway.stop()
      await close(upstream)
    }
  })

  it('rewrites same-origin browser headers and does not leak the host-owned dsh cookie', async () => {
    let seenOrigin: string | undefined
    let seenReferer: string | undefined
    const upstream = http.createServer((req, res) => {
      seenOrigin = req.headers.origin
      seenReferer = req.headers.referer
      res.writeHead(302, {
        location: '/next',
        'set-cookie': [
          'dsh-auth-test=should-stay-private; HttpOnly; Path=/',
          'harness-pref=mobile; Path=/',
        ],
      })
      res.end('redirected')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/`,
      upstreamCookie: 'dsh-auth-test=server-secret',
    })

    try {
      const { cookie } = await pairDevice(gateway, 'header-phone')
      const publicOrigin = new URL(gateway.localUrl).origin
      const response = await fetch(`${gateway.localUrl}source?from=mobile`, {
        headers: {
          cookie,
          origin: publicOrigin,
          referer: `${publicOrigin}/previous?from=mobile`,
        },
        redirect: 'manual',
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${publicOrigin}/next`)
      expect(response.headers.get('set-cookie')).toContain('harness-pref=mobile')
      expect(response.headers.get('set-cookie')).not.toContain('dsh-auth-test')
      expect(seenOrigin).toBe(new URL(`http://127.0.0.1:${upstreamPort}/`).origin)
      expect(seenReferer).toBe(`http://127.0.0.1:${upstreamPort}/previous?from=mobile`)
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

  it('requires a gateway session for WebSocket upgrades and forwards only authoritative dsh auth', async () => {
    let upstreamCookie: string | undefined
    let upstreamOrigin: string | undefined
    let upstreamReferer: string | undefined
    const upstream = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    upstream.on('upgrade', (req, socket) => {
      upstreamCookie = req.headers.cookie
      upstreamOrigin = req.headers.origin
      upstreamReferer = req.headers.referer
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.end('upstream-upgraded')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/`,
      upstreamCookie: 'dsh-auth-test=server-secret',
    })

    try {
      const unauthenticated = await rawTcpRequest(
        gateway.localUrl,
        'GET /stream HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      expect(unauthenticated).toContain('401 Unauthorized')

      const { cookie } = await pairDevice(gateway, 'streaming-phone')
      const authenticated = await rawTcpRequest(
        gateway.localUrl,
        `GET /stream HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${new URL(gateway.localUrl).origin}\r\nReferer: ${gateway.localUrl}previous\r\nCookie: ${cookie}; dsh-auth-test=forged\r\n\r\n`,
      )
      expect(authenticated).toContain('101 Switching Protocols')
      expect(authenticated).toContain('upstream-upgraded')
      expect(upstreamCookie).toBe('dsh-auth-test=server-secret')
      expect(upstreamOrigin).toBe(new URL(`http://127.0.0.1:${upstreamPort}/`).origin)
      expect(upstreamReferer).toBe(`http://127.0.0.1:${upstreamPort}/previous`)
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

  it('refuses a public gateway URL with a non-HTTP protocol', async () => {
    await expect(
      startHarnessGateway({
        upstreamUrl: 'http://127.0.0.1:65534/',
        publicBaseUrl: 'ftp://gateway.example/',
        allowInsecurePublicUrl: true,
      }),
    ).rejects.toThrow(/protocol/)
  })

  it('rejects invalid gateway lifetime and rate-limit settings before binding a port', async () => {
    const base = { upstreamUrl: 'http://127.0.0.1:65534/' }
    await expect(startHarnessGateway({ ...base, pairingTtlMs: 0 })).rejects.toThrow(/pairingTtlMs/)
    await expect(startHarnessGateway({ ...base, sessionTtlMs: Number.NaN })).rejects.toThrow(/sessionTtlMs/)
    await expect(startHarnessGateway({ ...base, maxPairingAttemptsPerMinute: -1 })).rejects.toThrow(/maxPairingAttemptsPerMinute/)
  })

  it('stops promptly and idempotently while a client connection is still open', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200)
      res.write('held-open')
    })
    const upstreamPort = await listen(upstream)
    const gateway = await startHarnessGateway({ upstreamUrl: `http://127.0.0.1:${upstreamPort}/` })
    const socket = net.connect(new URL(gateway.localUrl).port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    try {
      await expect(gateway.stop()).resolves.toBeUndefined()
      await expect(gateway.stop()).resolves.toBeUndefined()
      await new Promise<void>((resolve) => {
        if (socket.destroyed) resolve()
        else socket.once('close', () => resolve())
      })
      expect(socket.destroyed).toBe(true)
    } finally {
      socket.destroy()
      await close(upstream)
    }
  })
})
