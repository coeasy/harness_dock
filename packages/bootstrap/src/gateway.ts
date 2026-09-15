import { createHmac, randomBytes, randomInt } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'

const SESSION_COOKIE = 'harnessdock_session'
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000
const DEFAULT_LAUNCH_TTL_MS = 60_000
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000
const MAX_BODY_BYTES = 8 * 1024
const SERVER_CLOSE_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_GATEWAY_CONNECTIONS = 64
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface HarnessGatewayOptions {
  /** Authenticated local dsh Web URL, normally http://127.0.0.1:<port>/. */
  upstreamUrl: string
  /** Host-private dsh browser cookie. Never returned to or trusted from a mobile client. */
  upstreamCookie?: string
  /** Defaults to loopback. Use a TLS reverse proxy for remote access. */
  bindHost?: string
  port?: number
  /** Public HTTPS origin reached by mobile clients (for example Tailscale/Cloudflare Tunnel). */
  publicBaseUrl?: string
  pairingTtlMs?: number
  sessionTtlMs?: number
  maxPairingAttemptsPerMinute?: number
  /** Preview escape hatch. Never enable this for an Internet-facing gateway. */
  allowInsecurePublicUrl?: boolean
  log?: (message: string) => void
}

export interface GatewayPairingTicket {
  code: string
  expiresAt: string
}

export interface GatewayDeviceInfo {
  id: string
  name: string
  pairedAt: string
  lastSeenAt: string
  sessionExpiresAt: string
}

export interface HarnessGatewayHandle {
  readonly localUrl: string
  readonly publicUrl: string
  createPairingTicket(): GatewayPairingTicket
  listDevices(): GatewayDeviceInfo[]
  revokeDevice(deviceId: string): boolean
  revokeAllDevices(): number
  stop(): Promise<void>
}

interface PairingEntry {
  expiresAt: number
}

interface LaunchEntry {
  expiresAt: number
  deviceName: string
}

interface DeviceEntry {
  id: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

interface SessionEntry {
  expiresAt: number
  deviceId: string
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('Gateway base URLs must not contain credentials.')
  if (url.search || url.hash) throw new Error('Gateway base URLs must not contain query or fragment.')
  url.username = ''
  url.password = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}

function pairingCodeDisplay(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

function normalizePairingCode(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return parsed as Record<string, unknown>
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

function cookiePairs(cookie: string | undefined): string[] {
  if (!cookie) return []
  return cookie.split(';').map((part) => part.trim()).filter((part) => part.includes('='))
}

function cookieName(pair: string): string {
  const index = pair.indexOf('=')
  return index < 0 ? pair.trim() : pair.slice(0, index).trim()
}

function stripSessionCookie(cookie: string | undefined): string | undefined {
  const kept = cookiePairs(cookie).filter((part) => cookieName(part) !== SESSION_COOKIE)
  return kept.length ? kept.join('; ') : undefined
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
  return value
}

function positiveSafeDuration(value: number, name: string): number {
  positiveSafeInteger(value, name)
  if (value > Number.MAX_SAFE_INTEGER - Date.now()) {
    throw new Error(`${name} is too large.`)
  }
  return value
}

function rewriteSameOriginHeader(
  value: string | undefined,
  publicBase: URL,
  upstream: URL,
  referer: boolean,
): string | undefined {
  if (!value) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value
  }
  if (parsed.origin !== publicBase.origin) return value
  if (!referer) return upstream.origin
  return new URL(combineUpstreamPath(upstream, `${parsed.pathname}${parsed.search}`), `${upstream.origin}/`).toString()
}

function filterUpstreamSetCookie(
  value: string | string[],
  upstreamCookie: string | undefined,
): string | string[] | undefined {
  const protectedNames = new Set(cookiePairs(upstreamCookie).map(cookieName))
  if (protectedNames.size === 0) return value
  const values = Array.isArray(value) ? value : [value]
  const kept = values.filter((entry) => {
    const firstPart = entry.split(';', 1)[0] || ''
    return !protectedNames.has(cookieName(firstPart))
  })
  if (kept.length === 0) return undefined
  return Array.isArray(value) ? kept : kept[0]
}

/**
 * Merge client cookies with the host-owned dsh cookie. The authoritative dsh
 * cookie always wins and the HarnessDock Gateway session is never forwarded.
 */
function upstreamCookieHeader(clientCookie: string | undefined, upstreamCookie: string | undefined): string | undefined {
  const authoritative = cookiePairs(upstreamCookie)
  const protectedNames = new Set(authoritative.map(cookieName))
  const client = cookiePairs(stripSessionCookie(clientCookie)).filter((pair) => !protectedNames.has(cookieName(pair)))
  const merged = [...client, ...authoritative]
  return merged.length ? merged.join('; ') : undefined
}

function combineUpstreamPath(upstream: URL, requestUrl: string): string {
  const incoming = new URL(requestUrl, 'http://harnessdock.local')
  const prefix = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '')
  return `${prefix}${incoming.pathname}${incoming.search}` || '/'
}

function validSession(
  req: http.IncomingMessage,
  sessions: Map<string, SessionEntry>,
  devices: Map<string, DeviceEntry>,
  now = Date.now(),
): SessionEntry | undefined {
  const token = cookieValue(req, SESSION_COOKIE)
  if (!token) return undefined
  const session = sessions.get(token)
  if (!session) return undefined
  if (session.expiresAt <= now) {
    sessions.delete(token)
    return undefined
  }
  const device = devices.get(session.deviceId)
  if (!device) {
    sessions.delete(token)
    return undefined
  }
  device.lastSeenAt = now
  return session
}

export async function startHarnessGateway(options: HarnessGatewayOptions): Promise<HarnessGatewayHandle> {
  const upstream = normalizeBaseUrl(options.upstreamUrl)
  const configuredPublicBase = options.publicBaseUrl
    ? normalizeBaseUrl(options.publicBaseUrl)
    : undefined
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`Unsupported gateway upstream protocol: ${upstream.protocol}`)
  }
  if (!isLoopbackHost(upstream.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('HarnessDock gateway upstream must be a loopback HTTP(S) URL.')
  }
  if (configuredPublicBase && configuredPublicBase.protocol !== 'http:' && configuredPublicBase.protocol !== 'https:') {
    throw new Error(`Unsupported gateway publicBaseUrl protocol: ${configuredPublicBase.protocol}`)
  }

  const bindHost = options.bindHost?.trim() || '127.0.0.1'
  const port = options.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid gateway port: ${port}`)

  const pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxAttempts = options.maxPairingAttemptsPerMinute ?? 20
  positiveSafeDuration(pairingTtlMs, 'pairingTtlMs')
  positiveSafeDuration(sessionTtlMs, 'sessionTtlMs')
  positiveSafeInteger(maxAttempts, 'maxPairingAttemptsPerMinute')
  const pepper = randomBytes(32)
  const pairing = new Map<string, PairingEntry>()
  const launches = new Map<string, LaunchEntry>()
  const sessions = new Map<string, SessionEntry>()
  const devices = new Map<string, DeviceEntry>()
  const attemptWindows = new Map<string, { startedAt: number; count: number }>()

  const digestCode = (code: string): string =>
    createHmac('sha256', pepper).update(normalizePairingCode(code)).digest('hex')

  const prune = (now = Date.now()): void => {
    for (const [key, value] of pairing) if (value.expiresAt <= now) pairing.delete(key)
    for (const [key, value] of launches) if (value.expiresAt <= now) launches.delete(key)
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key)
    const activeDeviceIds = new Set([...sessions.values()].map((session) => session.deviceId))
    for (const deviceId of devices.keys()) if (!activeDeviceIds.has(deviceId)) devices.delete(deviceId)
    for (const [key, value] of attemptWindows) if (value.startedAt + 60_000 <= now) attemptWindows.delete(key)
  }

  const recordPairAttempt = (req: http.IncomingMessage): boolean => {
    const now = Date.now()
    const key = req.socket.remoteAddress || 'unknown'
    const current = attemptWindows.get(key)
    if (!current || current.startedAt + 60_000 <= now) {
      attemptWindows.set(key, { startedAt: now, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= maxAttempts
  }

  const revokeDeviceSessions = (deviceId: string): number => {
    let removed = 0
    for (const [token, session] of sessions) {
      if (session.deviceId !== deviceId) continue
      sessions.delete(token)
      removed += 1
    }
    devices.delete(deviceId)
    return removed
  }

  let publicBase: URL | undefined
  let stopped = false

  const server = http.createServer((req, res) => {
    void routeRequest(req, res).catch((error) => {
      options.log?.(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) json(res, 500, { error: 'gateway_internal_error' })
      else res.destroy()
    })
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = REQUEST_TIMEOUT_MS
  server.maxConnections = MAX_GATEWAY_CONNECTIONS
  const connections = new Set<net.Socket>()
  const trackConnection = (socket: net.Socket): void => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  }
  server.on('connection', (socket) => {
    trackConnection(socket)
  })

  const destroyConnections = (): void => {
    for (const socket of connections) socket.destroy()
  }

  const closeServer = async (): Promise<void> => {
    // Destroy the snapshot before stopping the listener. A connection can be
    // accepted while the event loop is between this operation and
    // `server.close()`, so the finalizer below repeats the sweep instead of
    // leaving a late idle/WebSocket socket behind.
    destroyConnections()
    await new Promise<void>((resolve) => {
      let finished = false
      let timer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        destroyConnections()
        resolve()
      }
      if (!server.listening) {
        finish()
        return
      }
      timer = setTimeout(finish, SERVER_CLOSE_TIMEOUT_MS)
      timer.unref()
      try {
        server.close(() => finish())
        server.closeAllConnections?.()
      } catch {
        finish()
      }
    })
    // `closeAllConnections()` does not include upgraded WebSocket sockets.
    // Sweep once more after the listener has stopped to cover both classes.
    destroyConnections()
  }

  async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    prune()
    if (stopped || !publicBase) {
      json(res, 503, { error: 'gateway_stopped' })
      return
    }
    const gatewayBase = publicBase
    const incoming = new URL(req.url || '/', 'http://harnessdock.local')

    if (incoming.pathname === '/api/harnessdock/health') {
      json(res, 200, {
        schemaVersion: 1,
        ok: true,
        provider: 'remote',
        appUrl: publicBase?.toString(),
      })
      return
    }

    if (incoming.pathname === '/api/harnessdock/pair') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        json(res, 405, { error: 'method_not_allowed' })
        return
      }
      if (!recordPairAttempt(req)) {
        json(res, 429, { error: 'pairing_rate_limited' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (error) {
        json(res, 400, { error: 'invalid_json', message: error instanceof Error ? error.message : String(error) })
        return
      }
      if (stopped) {
        json(res, 503, { error: 'gateway_stopped' })
        return
      }
      const code = typeof body.code === 'string' ? normalizePairingCode(body.code) : ''
      const requestedDeviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : ''
      const deviceName = (requestedDeviceName || 'HarnessDock Mobile').slice(0, 80)
      const key = code ? digestCode(code) : ''
      const ticket = key ? pairing.get(key) : undefined
      if (!ticket || ticket.expiresAt <= Date.now()) {
        if (key) pairing.delete(key)
        json(res, 401, { error: 'invalid_or_expired_pairing_code' })
        return
      }
      pairing.delete(key)
      const launchToken = randomBytes(32).toString('base64url')
      const launchExpiresAt = Date.now() + DEFAULT_LAUNCH_TTL_MS
      launches.set(launchToken, { expiresAt: launchExpiresAt, deviceName })
      const connectUrl = new URL('/api/harnessdock/connect', gatewayBase)
      connectUrl.searchParams.set('token', launchToken)
      json(res, 200, {
        connectUrl: connectUrl.toString(),
        expiresAt: new Date(launchExpiresAt).toISOString(),
      })
      return
    }

    if (incoming.pathname === '/api/harnessdock/connect') {
      const entries = [...incoming.searchParams.entries()]
      if (entries.length !== 1 || entries[0]?.[0] !== 'token' || !entries[0][1]) {
        json(res, 400, { error: 'invalid_connect_token' })
        return
      }
      const token = entries[0][1]
      const launch = launches.get(token)
      launches.delete(token)
      if (!launch || launch.expiresAt <= Date.now()) {
        json(res, 401, { error: 'invalid_or_expired_connect_token' })
        return
      }
      const now = Date.now()
      const deviceId = randomBytes(16).toString('hex')
      const sessionToken = randomBytes(32).toString('base64url')
      devices.set(deviceId, {
        id: deviceId,
        name: launch.deviceName,
        pairedAt: now,
        lastSeenAt: now,
      })
      sessions.set(sessionToken, { expiresAt: now + sessionTtlMs, deviceId })
      const secure = gatewayBase.protocol === 'https:' ? '; Secure' : ''
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(sessionTtlMs / 1000))}${secure}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }

    if (!validSession(req, sessions, devices)) {
      json(res, 401, { error: 'gateway_session_required' })
      return
    }

    if (stopped) {
      json(res, 503, { error: 'gateway_stopped' })
      return
    }
    await proxyHttp(req, res)
  }

  async function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const gatewayBase = publicBase
    if (!gatewayBase) {
      json(res, 503, { error: 'gateway_starting' })
      return
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: upstream.host }
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name]
    const origin = rewriteSameOriginHeader(req.headers.origin, gatewayBase, upstream, false)
    const referer = rewriteSameOriginHeader(req.headers.referer, gatewayBase, upstream, true)
    if (origin) headers.origin = origin
    else delete headers.origin
    if (referer) headers.referer = referer
    else delete headers.referer
    const cookie = upstreamCookieHeader(req.headers.cookie, options.upstreamCookie)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie

    const requestOptions: http.RequestOptions = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: combineUpstreamPath(upstream, req.url || '/'),
      headers,
    }

    await new Promise<void>((resolve, reject) => {
      const requestFn = upstream.protocol === 'https:' ? https.request : http.request
      const upstreamReq = requestFn(requestOptions, (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode ?? 502
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          const lowerName = name.toLowerCase()
          if (HOP_BY_HOP_HEADERS.has(lowerName)) continue
          const filteredCookie = lowerName === 'set-cookie'
            ? filterUpstreamSetCookie(value, options.upstreamCookie)
            : value
          if (filteredCookie === undefined) continue
          if (name.toLowerCase() === 'location' && typeof value === 'string') {
            try {
              const location = new URL(value, upstream)
              if (location.origin === upstream.origin && publicBase) {
                const rewritten = new URL(`${location.pathname}${location.search}${location.hash}`, publicBase)
                res.setHeader(name, rewritten.toString())
                continue
              }
            } catch {
              // pass through malformed/relative values below
            }
          }
          res.setHeader(name, filteredCookie)
        }
        upstreamRes.on('error', reject)
        upstreamRes.on('end', resolve)
        upstreamRes.pipe(res)
      })
      upstreamReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
        upstreamReq.destroy(new Error('Gateway upstream request timed out.'))
      })
      upstreamReq.on('error', reject)
      req.on('error', reject)
      req.on('aborted', () => upstreamReq.destroy())
      res.on('close', () => upstreamReq.destroy())
      req.pipe(upstreamReq)
    })
  }

  server.on('upgrade', (req, socket, head) => {
    prune()
    if (stopped || !publicBase) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const gatewayBase = publicBase
    if (!validSession(req, sessions, devices)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }

    const portNumber = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
    let connected = false
    const onConnected = (upstreamSocket: net.Socket): void => {
      if (connected || stopped || socket.destroyed || upstreamSocket.destroyed) {
        upstreamSocket.destroy()
        return
      }
      connected = true
      upstreamSocket.setTimeout(0)
      const headerLines: string[] = ['Connection: Upgrade', 'Upgrade: websocket']
      for (const [name, value] of Object.entries(req.headers)) {
        const lowerName = name.toLowerCase()
        if (lowerName === 'host' || lowerName === 'cookie' || HOP_BY_HOP_HEADERS.has(lowerName) || value === undefined) continue
        const rewritten = lowerName === 'origin' && typeof value === 'string'
          ? rewriteSameOriginHeader(value, gatewayBase, upstream, false)
          : lowerName === 'referer' && typeof value === 'string'
            ? rewriteSameOriginHeader(value, gatewayBase, upstream, true)
            : value
        if (Array.isArray(value)) {
          for (const item of rewritten as string[]) headerLines.push(`${name}: ${item}`)
        } else {
          headerLines.push(`${name}: ${rewritten}`)
        }
      }
      const cookie = upstreamCookieHeader(req.headers.cookie, options.upstreamCookie)
      if (cookie) headerLines.push(`Cookie: ${cookie}`)
      const requestHead = `${req.method || 'GET'} ${combineUpstreamPath(upstream, req.url || '/')} HTTP/${req.httpVersion}\r\nHost: ${upstream.host}\r\n${headerLines.join('\r\n')}\r\n\r\n`
      upstreamSocket.write(requestHead)
      if (head.length) upstreamSocket.write(head)
      socket.pipe(upstreamSocket).pipe(socket)
    }

    let upstreamSocket: net.Socket
    if (upstream.protocol === 'https:') {
      const tlsSocket = tls.connect({ host: upstream.hostname, port: portNumber, servername: upstream.hostname })
      upstreamSocket = tlsSocket
      tlsSocket.setTimeout(REQUEST_TIMEOUT_MS, () => tlsSocket.destroy(new Error('Gateway websocket upstream timed out.')))
      tlsSocket.once('secureConnect', () => onConnected(tlsSocket))
    } else {
      upstreamSocket = net.connect({ host: upstream.hostname, port: portNumber })
      upstreamSocket.setTimeout(REQUEST_TIMEOUT_MS, () => upstreamSocket.destroy(new Error('Gateway websocket upstream timed out.')))
      upstreamSocket.once('connect', () => onConnected(upstreamSocket))
    }
    trackConnection(upstreamSocket)
    upstreamSocket.on('error', (error) => {
      options.log?.(`websocket upstream failed: ${error.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstreamSocket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  })

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, bindHost, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer()
    throw new Error('HarnessDock gateway did not expose a TCP address.')
  }
  const hostForUrl = address.address.includes(':') ? `[${address.address}]` : address.address
  const localUrl = `http://${hostForUrl}:${address.port}/`
  publicBase = configuredPublicBase ?? normalizeBaseUrl(localUrl)
  const publicLoopback = isLoopbackHost(publicBase.hostname.replace(/^\[|\]$/g, ''))
  if (publicBase.protocol !== 'https:' && !publicLoopback && !options.allowInsecurePublicUrl) {
    await closeServer()
    throw new Error('Remote HarnessDock gateways require an HTTPS publicBaseUrl.')
  }
  if (!isLoopbackHost(bindHost) && !options.publicBaseUrl && !options.allowInsecurePublicUrl) {
    await closeServer()
    throw new Error('Non-loopback gateway binding requires an explicit HTTPS publicBaseUrl.')
  }
  if (publicBase.pathname !== '/' || publicBase.search || publicBase.hash || publicBase.username || publicBase.password) {
    await closeServer()
    throw new Error('HarnessDock gateway publicBaseUrl must be an origin-root URL (no path prefix).')
  }

  options.log?.(`listening on ${localUrl}; public=${publicBase.toString()}`)

  let stopPromise: Promise<void> | undefined
  const stopGateway = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (stopped) return
      stopped = true
      pairing.clear()
      launches.clear()
      sessions.clear()
      devices.clear()
      // Closing the listener alone waits for upgraded WebSocket connections.
      // Destroy every accepted socket first so Runtime shutdown cannot hang
      // forever on a mobile client that kept a tunnel open.
      await closeServer()
    })()
    return stopPromise
  }

  return {
    localUrl,
    publicUrl: publicBase.toString(),
    createPairingTicket() {
      prune()
      let raw: string | undefined
      let key: string | undefined
      for (let attempt = 0; attempt < 8; attempt += 1) {
        raw = randomInt(0, 100_000_000).toString().padStart(8, '0')
        key = digestCode(raw)
        if (!pairing.has(key)) break
        raw = undefined
        key = undefined
      }
      if (!raw || !key) throw new Error('Unable to allocate a unique pairing ticket.')
      const expiresAt = Date.now() + pairingTtlMs
      pairing.set(key, { expiresAt })
      return { code: pairingCodeDisplay(raw), expiresAt: new Date(expiresAt).toISOString() }
    },
    listDevices() {
      prune()
      const sessionExpiryByDevice = new Map<string, number>()
      for (const session of sessions.values()) {
        const current = sessionExpiryByDevice.get(session.deviceId) ?? 0
        if (session.expiresAt > current) sessionExpiryByDevice.set(session.deviceId, session.expiresAt)
      }
      return [...devices.values()]
        .map((device) => ({
          id: device.id,
          name: device.name,
          pairedAt: new Date(device.pairedAt).toISOString(),
          lastSeenAt: new Date(device.lastSeenAt).toISOString(),
          sessionExpiresAt: new Date(sessionExpiryByDevice.get(device.id) ?? device.lastSeenAt).toISOString(),
        }))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    },
    revokeDevice(deviceId) {
      prune()
      if (!devices.has(deviceId)) return false
      revokeDeviceSessions(deviceId)
      options.log?.(`revoked mobile device ${deviceId}`)
      return true
    },
    revokeAllDevices() {
      prune()
      const count = devices.size
      pairing.clear()
      launches.clear()
      sessions.clear()
      devices.clear()
      if (count) options.log?.(`revoked all mobile devices (${count})`)
      return count
    },
    stop: stopGateway,
  }
}
