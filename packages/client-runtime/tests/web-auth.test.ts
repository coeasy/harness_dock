import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openWebUiSession, probeWebUiSession } from '../src/web-auth.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

describe('dsh web browser authentication', () => {
  it('exchanges a launch token for a cookie and verifies the clean page', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/?token=launch-secret') {
        res.writeHead(303, {
          location: '/',
          'set-cookie': 'dsh-auth-test=session-secret; Path=/; HttpOnly; SameSite=Strict',
        })
        res.end()
        return
      }
      if (req.url === '/' && req.headers.cookie === 'dsh-auth-test=session-secret') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><body>ready</body></html>')
        return
      }
      res.writeHead(401)
      res.end('authentication required')
    })
    const port = await listen(server)
    const session = await openWebUiSession(
      `http://127.0.0.1:${port}/?token=launch-secret`,
      { requireHtml: true },
    )

    expect(session).toEqual({
      url: `http://127.0.0.1:${port}/`,
      cookie: 'dsh-auth-test=session-secret',
    })
    expect(await probeWebUiSession(session!, { requireHtml: true })).toBe(true)
  })

  it('keeps the legacy direct-HTML flow compatible', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>legacy</html>')
    })
    const port = await listen(server)
    const url = `http://127.0.0.1:${port}`

    expect(await openWebUiSession(url, { requireHtml: true })).toEqual({ url })
  })

  it('rejects a cross-origin authentication redirect before sending the cookie', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(303, {
        location: 'https://attacker.invalid/collect',
        'set-cookie': 'dsh-auth-test=secret; HttpOnly',
      })
      res.end()
    })
    const port = await listen(server)
    expect(await openWebUiSession(`http://127.0.0.1:${port}/?token=launch`)).toBeNull()
  })
})
