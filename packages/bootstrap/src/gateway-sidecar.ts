import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import * as http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openWebUiSession } from '../../client-runtime/src/web-auth.ts'
import { startHarnessGateway, type HarnessGatewayHandle } from './gateway.ts'

const ADMIN_BODY_LIMIT = 8 * 1024

interface SidecarReady {
  schemaVersion: 1
  pid: number
  adminUrl: string
  localUrl: string
  publicUrl: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > ADMIN_BODY_LIMIT) throw new Error('admin request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('admin body must be an object')
  return value as Record<string, unknown>
}

function bearer(req: http.IncomingMessage): string {
  const value = req.headers.authorization ?? ''
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : ''
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, filename)
}

async function listenLoopback(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('admin server did not expose a TCP address')
  return `http://127.0.0.1:${address.port}/`
}

async function stopServer(server: http.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

export async function runGatewaySidecar(): Promise<void> {
  const upstreamLaunchUrl = requiredEnv('HARNESSDOCK_SIDECAR_UPSTREAM_URL')
  const readyFile = requiredEnv('HARNESSDOCK_SIDECAR_READY_FILE')
  const adminToken = requiredEnv('HARNESSDOCK_SIDECAR_ADMIN_TOKEN')
  const upstream = await openWebUiSession(upstreamLaunchUrl, { timeoutMs: 8_000 })
  if (!upstream) throw new Error('failed to establish the authenticated dsh browser session')

  let gateway: HarnessGatewayHandle | undefined
  let shuttingDown = false
  const admin = http.createServer((req, res) => {
    void (async () => {
      if (bearer(req) !== adminToken) {
        json(res, 401, { error: 'admin_unauthorized' })
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/status') {
        json(res, 200, {
          running: true,
          localUrl: gateway?.localUrl,
          publicUrl: gateway?.publicUrl,
          devices: gateway?.listDevices() ?? [],
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/pair') {
        json(res, 200, gateway?.createPairingTicket())
        return
      }
      if (req.method === 'POST' && url.pathname === '/revoke') {
        const body = await readJson(req)
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
        if (!deviceId) {
          json(res, 400, { error: 'device_id_required' })
          return
        }
        json(res, 200, { revoked: gateway?.revokeDevice(deviceId) ?? false })
        return
      }
      if (req.method === 'POST' && url.pathname === '/revoke-all') {
        json(res, 200, { revoked: gateway?.revokeAllDevices() ?? 0 })
        return
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        json(res, 200, { stopping: true })
        queueMicrotask(() => void shutdown())
        return
      }
      json(res, 404, { error: 'admin_not_found' })
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { error: 'admin_internal_error' })
      else res.destroy()
      console.error(`gateway admin request failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await gateway?.stop().catch(() => undefined)
    await stopServer(admin).catch(() => undefined)
    await rm(readyFile, { force: true }).catch(() => undefined)
  }

  const handleSignal = (): void => {
    void shutdown().finally(() => process.exit(0))
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  try {
    gateway = await startHarnessGateway({
      upstreamUrl: upstream.url,
      upstreamCookie: upstream.cookie,
      bindHost: process.env.HARNESSDOCK_GATEWAY_BIND?.trim() || '127.0.0.1',
      port: Number.parseInt(process.env.HARNESSDOCK_GATEWAY_PORT?.trim() || '0', 10),
      publicBaseUrl: process.env.HARNESSDOCK_GATEWAY_PUBLIC_URL?.trim() || undefined,
      allowInsecurePublicUrl: process.env.HARNESSDOCK_GATEWAY_ALLOW_INSECURE === '1',
    })
    const adminUrl = await listenLoopback(admin)
    const ready: SidecarReady = {
      schemaVersion: 1,
      pid: process.pid,
      adminUrl,
      localUrl: gateway.localUrl,
      publicUrl: gateway.publicUrl,
    }
    await atomicWriteJson(readyFile, ready)
    console.log(`HarnessDock Gateway ready: ${gateway.publicUrl}`)
    await new Promise<void>((resolve) => admin.once('close', () => resolve()))
  } finally {
    await shutdown()
  }
}

const executedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (executedDirectly) {
  runGatewaySidecar().catch((error) => {
    console.error(`HarnessDock Gateway sidecar failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
