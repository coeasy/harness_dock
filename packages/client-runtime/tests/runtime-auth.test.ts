import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DshRuntime } from '../src/runtime.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dsh alpha authenticated readiness', () => {
  it('keeps the launch token for the browser without consuming it in the health probe', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-auth-'))
    temps.push(dir)
    const fake = path.join(dir, 'fake-auth-dsh.mjs')
    await writeFile(fake, `
import { createServer } from 'node:http'
const token = 'AlphaLaunchToken_abcdefghijklmnopqrstuvwxyz1234'
let exchanges = 0
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') === token) {
    exchanges += 1
    res.statusCode = 303
    res.setHeader('location', '/')
    res.setHeader('set-cookie', 'dsh_session=test; HttpOnly; SameSite=Strict; Path=/')
    res.end()
    return
  }
  if (req.url === '/exchanges') {
    res.end(String(exchanges))
    return
  }
  res.statusCode = 401
  res.end('unauthorized')
})
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  process.stdout.write('dsh web: http://127.0.0.1:' + addr.port + '/?token=' + token + '\\n')
})
setInterval(() => {}, 1 << 30)
`, 'utf8')

    const logs: string[] = []
    const runtime = new DshRuntime({
      origin: { dshVersion: '0.1.2-alpha.1' },
      pluginPath: path.join(dir, 'plugin.js'),
      cacheDir: dir,
      readyTimeoutMs: 10_000,
      readyStabilityMs: 200,
      env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
      log: (message) => logs.push(message),
      spawnImpl: (command, _args, options) =>
        spawn(command, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
    })

    try {
      const ready = await runtime.start()
      const launch = new URL(ready.url)
      expect(launch.searchParams.get('token')).toBe('AlphaLaunchToken_abcdefghijklmnopqrstuvwxyz1234')

      // Readiness must be TCP-only for token URLs; the browser owns the first
      // HTTP exchange that installs its HttpOnly cookie.
      const exchangesBeforeBrowser = await fetch(`${launch.origin}/exchanges`)
      expect(await exchangesBeforeBrowser.text()).toBe('0')

      const exchange = await fetch(ready.url, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      expect(exchange.headers.get('location')).toBe('/')
      expect(exchange.headers.get('set-cookie')).toContain('HttpOnly')

      expect(logs.some((line) => line.includes('AlphaLaunchToken_'))).toBe(false)
      expect(logs.some((line) => line.includes('token=<redacted>'))).toBe(true)
    } finally {
      await runtime.stop()
    }
  })
})
