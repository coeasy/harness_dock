import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DshRuntime } from '@dsh/client-runtime'
import { bootstrapRuntime } from '../src/runtime.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fake dsh: http server + stdout URL + ready file + keep-alive. */
async function fakeGoodScript(dir: string): Promise<string> {
  const fake = path.join(dir, 'fake-dsh.mjs')
  await writeFile(
    fake,
    `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const server = createServer((_req, res) => { res.end('ok') })
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  const port = addr.port
  process.stdout.write('dsh web: http://127.0.0.1:' + port + '\\n')
  if (process.env.DSH_EMBEDDED_READY_FILE) {
    writeFileSync(process.env.DSH_EMBEDDED_READY_FILE, JSON.stringify({
      url: 'http://127.0.0.1:' + port, host: '127.0.0.1', port,
      pid: process.pid, dshVersion: process.env.DSH_EMBEDDED_VERSION ?? 'test',
    }))
  }
})
setInterval(() => {}, 1 << 30)
`,
    'utf8',
  )
  return fake
}

/** A fake dsh that exits immediately (start() must reject). */
async function fakeFailScript(dir: string): Promise<string> {
  const fake = path.join(dir, 'fail-dsh.mjs')
  await writeFile(fake, `process.stderr.write('dsh boom\\n'); process.exit(1)\n`, 'utf8')
  return fake
}

function runtimeFactory(
  dir: string,
  goodScript: string,
  failScript: string,
): (origin: { dshVersion: string }) => DshRuntime {
  return (origin) => {
    const script = origin.dshVersion === 'bad' ? failScript : goodScript
    return new DshRuntime({
      origin,
      pluginPath: path.join(dir, 'plugin.js'),
      cacheDir: dir,
      readyTimeoutMs: 15_000,
      env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
      spawnImpl: (command, _args, options) =>
        spawn(process.execPath, [script], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
    })
  }
}

describe('bootstrapRuntime', () => {
  it(
    'boots with a fake dsh and records last-known-good only after success',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'bs-'))
      temps.push(dir)
      const originPath = path.join(dir, 'origin.json')
      await writeFile(originPath, `${JSON.stringify({ dshVersion: 'good' })}\n`, 'utf8')
      const goodScript = await fakeGoodScript(dir)
      const failScript = await fakeFailScript(dir)

      const result = await bootstrapRuntime({
        originPath,
        pluginPath: path.join(dir, 'plugin.js'),
        packaged: false,
        userDataDir: dir,
        dshRuntimeFactory: runtimeFactory(dir, goodScript, failScript),
      })

      expect(result.mode).toBe('local')
      expect(result.bundledAvailable).toBe(false)
      expect(result.rolledBack).toBeNull()
      expect(result.ready.port).toBeGreaterThan(0)
      expect(result.ready.url).toContain('127.0.0.1')

      // last-known-good recorded AFTER success
      const prev = JSON.parse(await readFile(path.join(dir, 'previous-origin.json'), 'utf8'))
      expect(prev.dshVersion).toBe('good')

      await result.runtime.stop()
    },
    25_000,
  )

  it(
    'can defer last-known-good persistence for a managed candidate until the host UI health gate',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'bs-'))
      temps.push(dir)
      const originPath = path.join(dir, 'origin.json')
      const prevPath = path.join(dir, 'previous-origin.json')
      await writeFile(originPath, `${JSON.stringify({ dshVersion: 'good' })}\n`, 'utf8')
      await writeFile(prevPath, `${JSON.stringify({ dshVersion: 'old-good' })}\n`, 'utf8')
      const goodScript = await fakeGoodScript(dir)
      const failScript = await fakeFailScript(dir)

      const result = await bootstrapRuntime({
        originPath,
        versionOverride: 'candidate',
        pluginPath: path.join(dir, 'plugin.js'),
        packaged: false,
        userDataDir: dir,
        deferOriginBackup: true,
        dshRuntimeFactory: runtimeFactory(dir, goodScript, failScript),
      })

      expect(result.origin.dshVersion).toBe('candidate')
      const prev = JSON.parse(await readFile(prevPath, 'utf8'))
      expect(prev.dshVersion).toBe('old-good')
      await result.runtime.stop()
    },
    25_000,
  )

  it(
    'rolls back to last-known-good when the pinned version fails to start',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'bs-'))
      temps.push(dir)
      const originPath = path.join(dir, 'origin.json')
      const prevPath = path.join(dir, 'previous-origin.json')
      await writeFile(originPath, `${JSON.stringify({ dshVersion: 'bad' })}\n`, 'utf8')
      // last-known-good from a previous successful run
      await writeFile(prevPath, `${JSON.stringify({ dshVersion: 'good' })}\n`, 'utf8')
      const goodScript = await fakeGoodScript(dir)
      const failScript = await fakeFailScript(dir)

      let rolledBackEvent: { from: string; to: string } | null = null
      const result = await bootstrapRuntime({
        originPath,
        pluginPath: path.join(dir, 'plugin.js'),
        packaged: false,
        userDataDir: dir,
        dshRuntimeFactory: runtimeFactory(dir, goodScript, failScript),
        onRollback: (info) => {
          rolledBackEvent = info
        },
      })

      expect(result.rolledBack).toEqual({ from: 'bad', to: 'good' })
      expect(rolledBackEvent).toEqual({ from: 'bad', to: 'good' })
      expect(result.origin.dshVersion).toBe('good')
      expect(result.ready.port).toBeGreaterThan(0)

      // the failing 'bad' version must NOT have overwritten last-known-good
      const prev = JSON.parse(await readFile(prevPath, 'utf8'))
      expect(prev.dshVersion).toBe('good')

      await result.runtime.stop()
    },
    25_000,
  )

  it(
    'rethrows the original error when there is no last-known-good to fall back to',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'bs-'))
      temps.push(dir)
      const originPath = path.join(dir, 'origin.json')
      await writeFile(originPath, `${JSON.stringify({ dshVersion: 'bad' })}\n`, 'utf8')
      const goodScript = await fakeGoodScript(dir)
      const failScript = await fakeFailScript(dir)

      await expect(
        bootstrapRuntime({
          originPath,
          pluginPath: path.join(dir, 'plugin.js'),
          packaged: false,
          userDataDir: dir,
          dshRuntimeFactory: runtimeFactory(dir, goodScript, failScript),
        }),
      ).rejects.toThrow(/exited before ready/)
    },
    25_000,
  )
})
