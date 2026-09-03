import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshRuntime } from '@dsh/client-runtime'
import { LocalRuntimeProvider } from '../src/local-runtime-provider.ts'
import { RemoteRuntimeProvider, normalizeRemoteGatewayUrl } from '../src/runtime-provider.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

 describe('RemoteRuntimeProvider', () => {
  it('requires HTTPS outside loopback development', () => {
    expect(() => normalizeRemoteGatewayUrl('http://example.com')).toThrow(/HTTPS/)
    expect(normalizeRemoteGatewayUrl('http://127.0.0.1:8080').toString()).toBe('http://127.0.0.1:8080/')
    expect(() => normalizeRemoteGatewayUrl('https://gateway.example/path')).toThrow(/origin roots/)
    expect(() => normalizeRemoteGatewayUrl('https://gateway.example/?token=secret')).toThrow(/query or fragment/)
    expect(() => normalizeRemoteGatewayUrl('https://user:pass@gateway.example')).toThrow(/credentials/)
  })

  it('pairs through the gateway and deduplicates concurrent connections', async () => {
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
      return new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        provider: 'remote',
        appUrl: 'https://gateway.example/',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const provider = new RemoteRuntimeProvider({
      gatewayUrl: 'https://gateway.example',
      pairingCode: '1234-5678',
      fetchImpl,
    })
    const [session, duplicate] = await Promise.all([provider.connect(), provider.connect()])
    expect(session.provider).toBe('remote')
    expect(duplicate).toBe(session)
    expect(session.appUrl).toContain('/api/harnessdock/connect?token=')
    expect(await provider.connect()).toBe(session)
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

describe('LocalRuntimeProvider', () => {
  it('deduplicates concurrent local bootstrap and disconnects without leaving a runtime', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'local-provider-'))
    temps.push(dir)
    const originPath = path.join(dir, 'origin.json')
    const fake = path.join(dir, 'fake-dsh.mjs')
    await writeFile(originPath, `${JSON.stringify({ dshVersion: 'test' })}\n`, 'utf8')
    await writeFile(
      fake,
      `
import { createServer } from 'node:http'
const server = createServer((_req, res) => { res.end('ok') })
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  process.stdout.write('dsh web: http://127.0.0.1:' + addr.port + '\\n')
})
setInterval(() => {}, 1 << 30)
`,
      'utf8',
    )

    const provider = new LocalRuntimeProvider({
      originPath,
      pluginPath: path.join(dir, 'plugin.js'),
      packaged: false,
      userDataDir: dir,
      dshRuntimeFactory: (origin) =>
        new DshRuntime({
          origin,
          pluginPath: path.join(dir, 'plugin.js'),
          cacheDir: dir,
          readyTimeoutMs: 15_000,
          env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
          spawnImpl: (command, _args, options) =>
            spawn(process.execPath, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
        }),
    })

    const [first, second] = await Promise.all([provider.connect(), provider.connect()])
    expect(second.appUrl).toBe(first.appUrl)
    expect(provider.bootstrapResult?.ready.url).toBe(first.appUrl)
    await provider.disconnect()
    expect((await provider.health()).ok).toBe(false)
  }, 25_000)
})
