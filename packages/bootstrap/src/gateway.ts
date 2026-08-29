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

export interface HarnessGatewayOptions {
  /** Local dsh ready URL, normally http://127.0.0.1:<port>. */
  upstreamUrl: string
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

export interface HarnessGatewayHandle {
  readonly localUrl: string
  readonly publicUrl: string
  createPairingTicket(): GatewayPairingTicket
  stop(): Promise<void>
}

interface PairingEntry {
  expiresAt: number
}

interface LaunchEntry {
  expiresAt: number
  deviceName: string
}

interface SessionEntry {
  expiresAt: number
  deviceName: string
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.hash = ''
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

function stripSessionCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !part.startsWith(`${SESSION_COOKIE}=`))
  return kept.length ? kept.join('; ') : undefined
}

function combineUpstreamPath(upstream: URL, requestUrl: string): string {
  const incoming = new URL(requestUrl, 'http://harnessdock.local')
  const prefix = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '')
  return `${prefix}${incoming.pathname}${incoming.search}` || '/'
}

function validSession(
  req: http.IncomingMessage,
  sessions: Map<string, SessionEntry>,
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
  return session
}

export async function startHarnessGateway(options: HarnessGatewayOptions): Promise<HarnessGatewayHandle> {
  const upstream = normalizeBaseUrl(options.upstreamUrl)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`Unsupported gateway upstream protocol: ${upstream.protocol}`)
  }

  const bindHost = options.bindHost?.trim() || '127.0.0.1'
  const port = options.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid gateway port: ${port}`)

  const pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxAttempts = options.maxPairingAttemptsPerMinute ?? 20
  const pepper = randomBytes(32)
  const pairing = new Map<string, PairingEntry>()
  const launches = new Map<string, LaunchEntry>()
  const sessions = new Map<string, SessionEntry>()
  const attemptWindows = new Map<string, { startedAt: number; count: number }>()

  const digestCode = (code: string): string =>
    createHmac('sha256', pepper).update(normalizePairingCode(code)).digest('hex')

  const prune = (now = Date.now()): void => {
    for (const [key, value] of pairing) if (value.expiresAt <= now) pairing.delete(key)
    for (const [key, value] of launches) if (value.expiresAt <= now) launches.delete(key)
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key)
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

  let publicBase: URL | undefined

  const server = http.createServer((req, res) => {
    void routeRequest(req, res).catch((error) => {
      options.log?.(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) json(res, 500, { error: 'gateway_internal_error' })
      else res.destroy()
    })
  })

  async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    prune()
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
      const code = typeof body.code === 'string' ? normalizePairingCode(body.code) : ''
      const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : 'HarnessDock Mobile'
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
      const connectUrl = new URL('/api/harnessdock/connect', publicBase)
      connectUrl.searchParams.set('token', launchToken)
      json(res, 200, {
        connectUrl: connectUrl.toString(),
        expiresAt: new Date(launchExpiresAt).toISOString(),
      })
      return
    }

    if (incoming.pathname === '/api/harnessdock/connect') {
      const token = incoming.searchParams.get('token') || ''
      const launch = launches.get(token)
      launches.delete(token)
      if (!launch || launch.expiresAt <= Date.now()) {
        json(res, 401, { error: 'invalid_or_expired_connect_token' })
        return
      }
      const sessionToken = randomBytes(32).toString('base64url')
      sessions.set(sessionToken, { expiresAt: Date.now() + sessionTtlMs, deviceName: launch.deviceName })
      const secure = publicBase?.protocol === 'https:' ? '; Secure' : ''
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }

    if (!validSession(req, sessions)) {
      json(res, 401, { error: 'gateway_session_required' })
      return
    }

    await proxyHttp(req, res)
  }

  async function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: upstream.host }
    delete headers.connection
    delete headers['proxy-connection']
    delete headers['keep-alive']
    delete headers['transfer-encoding']
    delete headers.upgrade
    const upstreamCookie = stripSessionCookie(req.headers.cookie)
    if (upstreamCookie) headers.cookie = upstreamCookie
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
          res.setHeader(name, value)
        }
        upstreamRes.on('error', reject)
        upstreamRes.on('end', resolve)
        upstreamRes.pipe(res)
      })
      upstreamReq.on('error', reject)
      req.on('error', reject)
      req.pipe(upstreamReq)
    })
  }

  server.on('upgrade', (req, socket, head) => {
    prune()
    if (!validSession(req, sessions)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }

    const portNumber = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
    const onConnected = (upstreamSocket: net.Socket): void => {
      const headerLines: string[] = []
      for (const [name, value] of Object.entries(req.headers)) {
        if (name.toLowerCase() === 'host' || value === undefined) continue
        if (name.toLowerCase() === 'cookie') {
          const cookie = stripSessionCookie(Array.isArray(value) ? value.join('; ') : value)
          if (cookie) headerLines.push(`Cookie: ${cookie}`)
          continue
        }
        if (Array.isArray(value)) {
          for (const item of value) headerLines.push(`${name}: ${item}`)
        } else {
          headerLines.push(`${name}: ${value}`)
        }
      }
      const requestHead = `${req.method || 'GET'} ${combineUpstreamPath(upstream, req.url || '/')} HTTP/${req.httpVersion}\r\nHost: ${upstream.host}\r\n${headerLines.join('\r\n')}\r\n\r\n`
      upstreamSocket.write(requestHead)
      if (head.length) upstreamSocket.write(head)
      socket.pipe(upstreamSocket).pipe(socket)
    }

    let upstreamSocket: net.Socket
    if (upstream.protocol === 'https:') {
      const tlsSocket = tls.connect({ host: upstream.hostname, port: portNumber, servername: upstream.hostname })
      upstreamSocket = tlsSocket
      tlsSocket.once('secureConnect', () => onConnected(tlsSocket))
    } else {
      upstreamSocket = net.connect({ host: upstream.hostname, port: portNumber })
      upstreamSocket.once('connect', () => onConnected(upstreamSocket))
    }
    upstreamSocket.on('error', (error) => {
      options.log?.(`websocket upstream failed: ${error.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstreamSocket.destroy())
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
    server.close()
    throw new Error('HarnessDock gateway did not expose a TCP address.')
  }
  const hostForUrl = address.address.includes(':') ? `[${address.address}]` : address.address
  const localUrl = `http://${hostForUrl}:${address.port}/`
  publicBase = options.publicBaseUrl ? normalizeBaseUrl(options.publicBaseUrl) : normalizeBaseUrl(localUrl)
  const publicLoopback = isLoopbackHost(publicBase.hostname.replace(/^\[|\]$/g, ''))
  if (publicBase.protocol !== 'https:' && !publicLoopback && !options.allowInsecurePublicUrl) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Remote HarnessDock gateways require an HTTPS publicBaseUrl.')
  }
  if (!isLoopbackHost(bindHost) && !options.publicBaseUrl && !options.allowInsecurePublicUrl) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Non-loopback gateway binding requires an explicit HTTPS publicBaseUrl.')
  }

  options.log?.(`listening on ${localUrl}; public=${publicBase.toString()}`)

  return {
    localUrl,
    publicUrl: publicBase.toString(),
    createPairingTicket() {
      prune()
      let raw = ''
      let key = ''
      do {
        raw = randomInt(0, 100_000_000).toString().padStart(8, '0')
        key = digestCode(raw)
      } while (pairing.has(key))
      const expiresAt = Date.now() + pairingTtlMs
      pairing.set(key, { expiresAt })
      return { code: pairingCodeDisplay(raw), expiresAt: new Date(expiresAt).toISOString() }
    },
    async stop() {
      pairing.clear()
      launches.clear()
      sessions.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
