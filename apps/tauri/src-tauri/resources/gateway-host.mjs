import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import path from 'node:path'

const SESSION_COOKIE = 'harnessdock_session'
const PAIRING_TTL_MS = 5 * 60_000
const LAUNCH_TTL_MS = 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
const MAX_BODY_BYTES = 8 * 1024
const MAX_PAIRING_ATTEMPTS_PER_MINUTE = 20

const upstream = normalizeBaseUrl(requiredEnv('HARNESSDOCK_GATEWAY_UPSTREAM'))
const bindHost = process.env.HARNESSDOCK_GATEWAY_BIND?.trim() || '127.0.0.1'
const port = parsePort(process.env.HARNESSDOCK_GATEWAY_PORT || '0')
const requestedPublicUrl = process.env.HARNESSDOCK_GATEWAY_PUBLIC_URL?.trim() || ''
const allowInsecure = process.env.HARNESSDOCK_GATEWAY_ALLOW_INSECURE === '1'
const adminToken = requiredEnv('HARNESSDOCK_GATEWAY_ADMIN_TOKEN')
const readyFile = requiredEnv('HARNESSDOCK_GATEWAY_READY_FILE')
const pepper = randomBytes(32)

const pairing = new Map()
const launches = new Map()
const sessions = new Map()
const devices = new Map()
const attemptWindows = new Map()
let publicBase
let upstreamAuthCookie = ''

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`Invalid gateway port: ${value}`)
  return parsed
}

function normalizeBaseUrl(value) {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function isLoopbackHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}

function isPrivateHost(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopbackHost(value) || value.endsWith('.local')) return true
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((part) => part < 0 || part > 255)) return false
    const [a, b] = octets
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')
}

function validatePublicUrl(url) {
  if (url.pathname !== '/') throw new Error('Gateway public URL must be an origin-root URL without a path prefix.')
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && allowInsecure && isPrivateHost(url.hostname)) return
  throw new Error('Remote Gateway requires HTTPS; HTTP is allowed only for an explicitly approved private/loopback LAN address.')
}

function json(res, status, body) {
  const data = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(data)
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body too large.')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return parsed
}

function cookieValue(req, name) {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

function stripSessionCookie(cookie) {
  if (!cookie) return ''
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
    .join('; ')
}

function mergeCookies(...cookies) {
  return cookies.map((value) => String(value || '').trim()).filter(Boolean).join('; ')
}

function setCookiePair(value) {
  if (!value) return ''
  const first = Array.isArray(value) ? value[0] : value
  return String(first || '').split(';', 1)[0]?.trim() || ''
}

function combineUpstreamPath(requestUrl) {
  const incoming = new URL(requestUrl, 'http://harnessdock.local')
  const prefix = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '')
  return `${prefix}${incoming.pathname}${incoming.search}` || '/'
}

function digestCode(code) {
  return createHmac('sha256', pepper).update(String(code || '').replace(/[^0-9]/g, '')).digest('hex')
}

function pairingCodeDisplay(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

function prune(now = Date.now()) {
  for (const [key, value] of pairing) if (value.expiresAt <= now) pairing.delete(key)
  for (const [key, value] of launches) if (value.expiresAt <= now) launches.delete(key)
  for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key)
  const active = new Set([...sessions.values()].map((session) => session.deviceId))
  for (const id of devices.keys()) if (!active.has(id)) devices.delete(id)
  for (const [key, value] of attemptWindows) if (value.startedAt + 60_000 <= now) attemptWindows.delete(key)
}

function recordPairAttempt(req) {
  const now = Date.now()
  const key = req.socket.remoteAddress || 'unknown'
  const current = attemptWindows.get(key)
  if (!current || current.startedAt + 60_000 <= now) {
    attemptWindows.set(key, { startedAt: now, count: 1 })
    return true
  }
  current.count += 1
  return current.count <= MAX_PAIRING_ATTEMPTS_PER_MINUTE
}

function validSession(req, now = Date.now()) {
  const token = cookieValue(req, SESSION_COOKIE)
  if (!token) return undefined
  const session = sessions.get(token)
  if (!session || session.expiresAt <= now) {
    if (token) sessions.delete(token)
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

function createPairingTicket() {
  prune()
  let raw = ''
  let key = ''
  do {
    raw = randomInt(0, 100_000_000).toString().padStart(8, '0')
    key = digestCode(raw)
  } while (pairing.has(key))
  const expiresAt = Date.now() + PAIRING_TTL_MS
  pairing.set(key, { expiresAt })
  return { code: pairingCodeDisplay(raw), expiresAt: new Date(expiresAt).toISOString() }
}

function listDevices() {
  prune()
  const expiry = new Map()
  for (const session of sessions.values()) {
    expiry.set(session.deviceId, Math.max(expiry.get(session.deviceId) || 0, session.expiresAt))
  }
  return [...devices.values()]
    .map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: new Date(device.pairedAt).toISOString(),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
      sessionExpiresAt: new Date(expiry.get(device.id) || device.lastSeenAt).toISOString(),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

function revokeDevice(deviceId) {
  let removed = false
  for (const [token, session] of sessions) {
    if (session.deviceId !== deviceId) continue
    sessions.delete(token)
    removed = true
  }
  if (devices.delete(deviceId)) removed = true
  return removed
}

function revokeAll() {
  const count = devices.size
  pairing.clear()
  launches.clear()
  sessions.clear()
  devices.clear()
  return count
}

async function primeUpstreamAuthentication() {
  if (!upstream.search) return
  const result = await rawHttpRequest(upstream, { method: 'GET', headers: { accept: 'text/html' } })
  if (result.status >= 400) throw new Error(`Upstream launch-token handshake failed with HTTP ${result.status}`)
  const cookie = setCookiePair(result.headers['set-cookie'])
  if (cookie) upstreamAuthCookie = cookie
  if (result.status === 303 && result.headers.location) {
    const clean = new URL(result.headers.location, upstream)
    if (clean.origin !== upstream.origin) throw new Error('Upstream authentication redirected to another origin.')
    upstream.pathname = clean.pathname
    upstream.search = clean.search
  }
}

function rawHttpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === 'https:' ? https.request : http.request
    const req = requestFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: options.method || 'GET',
      path: `${url.pathname}${url.search}`,
      headers: options.headers || {},
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes <= 256 * 1024) chunks.push(Buffer.from(chunk))
      })
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function proxyHttp(req, res) {
  const headers = { ...req.headers, host: upstream.host }
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['keep-alive']
  delete headers['transfer-encoding']
  delete headers.upgrade
  const forwardedCookie = stripSessionCookie(req.headers.cookie)
  const mergedCookie = mergeCookies(upstreamAuthCookie, forwardedCookie)
  if (mergedCookie) headers.cookie = mergedCookie
  else delete headers.cookie

  await new Promise((resolve, reject) => {
    const requestFn = upstream.protocol === 'https:' ? https.request : http.request
    const upstreamReq = requestFn({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: combineUpstreamPath(req.url || '/'),
      headers,
    }, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode || 502
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || name.toLowerCase() === 'set-cookie') continue
        if (name.toLowerCase() === 'location' && typeof value === 'string') {
          try {
            const location = new URL(value, upstream)
            if (location.origin === upstream.origin && publicBase) {
              const rewritten = new URL(`${location.pathname}${location.search}${location.hash}`, publicBase)
              res.setHeader(name, rewritten.toString())
              continue
            }
          } catch {}
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

async function routePublic(req, res) {
  prune()
  const incoming = new URL(req.url || '/', 'http://harnessdock.local')
  if (incoming.pathname === '/api/harnessdock/health') {
    json(res, 200, { schemaVersion: 1, ok: true, provider: 'remote', appUrl: publicBase?.toString() })
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
    let body
    try { body = await readJsonBody(req) }
    catch (error) {
      json(res, 400, { error: 'invalid_json', message: error instanceof Error ? error.message : String(error) })
      return
    }
    const normalized = typeof body.code === 'string' ? body.code.replace(/[^0-9]/g, '') : ''
    const key = normalized ? digestCode(normalized) : ''
    const ticket = key ? pairing.get(key) : undefined
    if (!ticket || ticket.expiresAt <= Date.now()) {
      if (key) pairing.delete(key)
      json(res, 401, { error: 'invalid_or_expired_pairing_code' })
      return
    }
    pairing.delete(key)
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 80) : 'HarnessDock Mobile'
    const launchToken = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + LAUNCH_TTL_MS
    launches.set(launchToken, { expiresAt, deviceName })
    const connectUrl = new URL('/api/harnessdock/connect', publicBase)
    connectUrl.searchParams.set('token', launchToken)
    json(res, 200, { connectUrl: connectUrl.toString(), expiresAt: new Date(expiresAt).toISOString() })
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
    const now = Date.now()
    const deviceId = randomBytes(16).toString('hex')
    const sessionToken = randomBytes(32).toString('base64url')
    devices.set(deviceId, { id: deviceId, name: launch.deviceName, pairedAt: now, lastSeenAt: now })
    sessions.set(sessionToken, { deviceId, expiresAt: now + SESSION_TTL_MS })
    const secure = publicBase.protocol === 'https:' ? '; Secure' : ''
    res.writeHead(302, {
      location: '/',
      'set-cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return
  }

  if (!validSession(req)) {
    json(res, 401, { error: 'gateway_session_required' })
    return
  }
  await proxyHttp(req, res)
}

function bearerAuthorized(req) {
  const value = req.headers.authorization || ''
  const expected = `Bearer ${adminToken}`
  const a = Buffer.from(value)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function routeAdmin(req, res) {
  if (!bearerAuthorized(req)) {
    json(res, 401, { error: 'admin_auth_required' })
    return
  }
  const incoming = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && incoming.pathname === '/status') {
    json(res, 200, { publicUrl: publicBase.toString(), devices: listDevices().length })
    return
  }
  if (req.method === 'POST' && incoming.pathname === '/pairing') {
    json(res, 200, createPairingTicket())
    return
  }
  if (req.method === 'GET' && incoming.pathname === '/devices') {
    json(res, 200, listDevices())
    return
  }
  if (req.method === 'POST' && incoming.pathname === '/revoke') {
    let body
    try { body = await readJsonBody(req) }
    catch (error) { json(res, 400, { error: 'invalid_json', message: String(error) }); return }
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    json(res, 200, { revoked: deviceId ? revokeDevice(deviceId) : false })
    return
  }
  if (req.method === 'POST' && incoming.pathname === '/revoke-all') {
    json(res, 200, { revoked: revokeAll() })
    return
  }
  json(res, 404, { error: 'not_found' })
}

await primeUpstreamAuthentication()

const publicServer = http.createServer((req, res) => {
  void routePublic(req, res).catch((error) => {
    console.error('[gateway] public request failed', error)
    if (!res.headersSent) json(res, 500, { error: 'gateway_internal_error' })
    else res.destroy()
  })
})

publicServer.on('upgrade', (req, socket, head) => {
  prune()
  if (!validSession(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const portNumber = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80))
  const onConnected = (upstreamSocket) => {
    const headerLines = []
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'cookie' || value === undefined) continue
      if (Array.isArray(value)) for (const item of value) headerLines.push(`${name}: ${item}`)
      else headerLines.push(`${name}: ${value}`)
    }
    const cookie = mergeCookies(upstreamAuthCookie, stripSessionCookie(req.headers.cookie))
    if (cookie) headerLines.push(`Cookie: ${cookie}`)
    const requestHead = `${req.method || 'GET'} ${combineUpstreamPath(req.url || '/')} HTTP/${req.httpVersion}\r\nHost: ${upstream.host}\r\n${headerLines.join('\r\n')}\r\n\r\n`
    upstreamSocket.write(requestHead)
    if (head.length) upstreamSocket.write(head)
    socket.pipe(upstreamSocket).pipe(socket)
  }
  let upstreamSocket
  if (upstream.protocol === 'https:') {
    const secure = tls.connect({ host: upstream.hostname, port: portNumber, servername: upstream.hostname })
    upstreamSocket = secure
    secure.once('secureConnect', () => onConnected(secure))
  } else {
    upstreamSocket = net.connect({ host: upstream.hostname, port: portNumber })
    upstreamSocket.once('connect', () => onConnected(upstreamSocket))
  }
  upstreamSocket.on('error', (error) => {
    console.error('[gateway] websocket upstream failed', error)
    socket.destroy()
  })
  socket.on('error', () => upstreamSocket.destroy())
})

publicServer.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))

await new Promise((resolve, reject) => {
  publicServer.once('error', reject)
  publicServer.listen(port, bindHost, () => resolve())
})

const address = publicServer.address()
if (!address || typeof address === 'string') throw new Error('Gateway did not expose a TCP address.')
const hostForUrl = address.address.includes(':') ? `[${address.address}]` : address.address
const localUrl = `http://${hostForUrl}:${address.port}/`
publicBase = requestedPublicUrl ? normalizeBaseUrl(requestedPublicUrl) : normalizeBaseUrl(localUrl)
validatePublicUrl(publicBase)
if (!isLoopbackHost(bindHost) && !requestedPublicUrl) throw new Error('Non-loopback Gateway binding requires an explicit public URL.')

const adminServer = http.createServer((req, res) => {
  void routeAdmin(req, res).catch((error) => {
    console.error('[gateway] admin request failed', error)
    if (!res.headersSent) json(res, 500, { error: 'admin_internal_error' })
    else res.destroy()
  })
})
await new Promise((resolve, reject) => {
  adminServer.once('error', reject)
  adminServer.listen(0, '127.0.0.1', () => resolve())
})
const adminAddress = adminServer.address()
if (!adminAddress || typeof adminAddress === 'string') throw new Error('Gateway admin server did not expose a TCP address.')
const adminUrl = `http://127.0.0.1:${adminAddress.port}/`

await mkdir(path.dirname(readyFile), { recursive: true })
await writeFile(readyFile, `${JSON.stringify({ localUrl, publicUrl: publicBase.toString(), adminUrl }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
console.log(`[gateway] ready public=${publicBase.toString()} local=${localUrl}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  revokeAll()
  await Promise.all([
    new Promise((resolve) => publicServer.close(() => resolve())),
    new Promise((resolve) => adminServer.close(() => resolve())),
  ])
}
process.on('SIGTERM', () => void stop().finally(() => process.exit(0)))
process.on('SIGINT', () => void stop().finally(() => process.exit(0)))
