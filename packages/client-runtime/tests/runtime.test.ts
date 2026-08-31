import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DshRuntime } from '../src/runtime.ts'
import { bundledDshBin, bundledNodeRel } from '../src/bundled.ts'

const temps: string[] = []

const READY_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 15_000
const TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 20_000

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fakeUrlScript(dir: string): Promise<string> {
  const fake = path.join(dir, 'fake-dsh.mjs')
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
  return fake
}

async function fixtureBundledRoot(dir: string, dshVersion: string): Promise<string> {
  const root = path.join(dir, 'bundled')
  const nodeBin = path.join(root, bundledNodeRel(process.platform))
  await mkdir(path.dirname(nodeBin), { recursive: true })
  await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(nodeBin, '')
  await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
  await writeFile(
    path.join(root, 'manifest.json'),
    `${JSON.stringify({ dshVersion, nodeVersion: '22.19.0' })}\n`,
    'utf8',
  )
  return root
}

describe('DshRuntime', () => {
  it(
    'waits for the stdout URL from a fake dsh process',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rt-'))
      temps.push(dir)
      const fake = path.join(dir, 'fake-dsh.mjs')
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

      const runtime = new DshRuntime({
        origin: { dshVersion: '0.1.1-rc.2' },
        pluginPath: path.join(dir, 'missing-plugin.js'),
        cacheDir: dir,
        readyTimeoutMs: READY_TIMEOUT_MS,
        env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
        spawnImpl: (command, _args, options) =>
          spawn(command, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
      })

      try {
        const ready = await runtime.start()
        expect(ready.host).toBe('127.0.0.1')
        expect(ready.port).toBeGreaterThan(0)
        const response = await fetch(ready.url)
        expect(await response.text()).toBe('ok')
      } finally {
        await runtime.stop()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'rejects a transient web server that crashes during the stability window',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rt-'))
      temps.push(dir)
      const fake = path.join(dir, 'crashing-dsh.mjs')
      await writeFile(
        fake,
        `
import { createServer } from 'node:http'
const server = createServer((_req, res) => { res.end('<html>temporary</html>') })
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  process.stdout.write('dsh web: http://127.0.0.1:' + addr.port + '\\n')
  setTimeout(() => process.exit(19), 100)
})
`,
        'utf8',
      )
      const logs: string[] = []
      const runtime = new DshRuntime({
        origin: { dshVersion: '0.1.1-rc.2' },
        pluginPath: path.join(dir, 'missing-plugin.js'),
        cacheDir: dir,
        readyTimeoutMs: READY_TIMEOUT_MS,
        readyStabilityMs: 500,
        env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
        log: (message) => logs.push(message),
        spawnImpl: (command, _args, options) =>
          spawn(command, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
      })

      await expect(runtime.start()).rejects.toThrow('dsh exited before ready (code 19)')
      expect(logs.some((line) => line.includes('dsh web: http://127.0.0.1:'))).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'isolates multiple incompatible external plugins in one recovery boot and reuses quarantine on next launch',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-'))
      temps.push(dir)
      const plugin = path.join(dir, 'embedded-client.js')
      const good = await fakeUrlScript(dir)
      const fail = path.join(dir, 'plugin-fail.mjs')
      const quarantine = path.join(dir, 'plugin-quarantine.json')
      await writeFile(plugin, 'export default {}\n', 'utf8')
      await writeFile(fail, `process.stderr.write('legacy-a plugin failed\\n'); process.exit(1)\n`, 'utf8')
      const dump = `# == @deepseek-ai/dsh-bundle-base
- id: official-core
  name: '@deepseek-ai/plugin-core'
# == third-party-a
- id: legacy-a
  name: '@legacy/a'
# == third-party-b
- id: legacy-b
  name: '@legacy/b'
# == C:\\Temp\\embedded.patch.yml
- id: embedded-client
  name: 'file:///embedded-client.js'
`

      const first = new DshRuntime({
        origin: { dshVersion: '0.1.2-alpha.1' },
        pluginPath: plugin,
        packaged: true,
        cacheDir: dir,
        pluginQuarantinePath: quarantine,
        readyTimeoutMs: READY_TIMEOUT_MS,
        readyStabilityMs: 50,
        env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
        configDumpImpl: async () => dump,
        spawnImpl: (_command, args, options) => {
          const recovering = args.some((value) => value.includes('plugin-recovery.patch.yml'))
          return spawn(process.execPath, [recovering ? good : fail], {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        },
      })

      try {
        await first.start()
        expect(first.pluginRecoveryState).toMatchObject({
          active: true,
          source: 'startup-failure',
          isolatedPlugins: ['legacy-a', 'legacy-b'],
          suspectedPlugins: ['legacy-a'],
          reason: 'diagnostic-match',
        })
      } finally {
        await first.stop()
      }

      let normalSpawnCount = 0
      const second = new DshRuntime({
        origin: { dshVersion: '0.1.2-alpha.1' },
        pluginPath: plugin,
        packaged: true,
        cacheDir: dir,
        pluginQuarantinePath: quarantine,
        readyTimeoutMs: READY_TIMEOUT_MS,
        readyStabilityMs: 50,
        env: { DSH_RUNTIME: 'local', DSH_BIN: process.execPath },
        configDumpImpl: async () => {
          throw new Error('config dump should not be needed for a valid quarantine')
        },
        spawnImpl: (_command, args, options) => {
          const quarantined = args.some((value) => value.includes('plugin-quarantine.patch.yml'))
          if (!quarantined) normalSpawnCount += 1
          return spawn(process.execPath, [quarantined ? good : fail], {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        },
      })

      try {
        await second.start()
        expect(normalSpawnCount).toBe(0)
        expect(second.pluginRecoveryState).toMatchObject({
          active: true,
          source: 'quarantine',
          isolatedPlugins: ['legacy-a', 'legacy-b'],
          suspectedPlugins: ['legacy-a'],
        })
      } finally {
        await second.stop()
      }
    },
    TEST_TIMEOUT_MS,
  )
})

describe('DshRuntime bundled follow-pin (Phase B)', () => {
  it(
    'fetches the pinned version and runs it with the bundled node when the seed differs',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bd-'))
      temps.push(dir)
      const bundledRoot = await fixtureBundledRoot(dir, '0.1.0')
      const fake = await fakeUrlScript(dir)
      const downloadedBin = path.join(dir, 'runtime-0.1.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

      let spawnCommand = ''
      let spawnArgs: string[] = []
      const runtime = new DshRuntime({
        origin: { dshVersion: '0.1.1' },
        pluginPath: path.join(dir, 'plugin.js'),
        cacheDir: dir,
        bundledRoot,
        readyTimeoutMs: READY_TIMEOUT_MS,
        env: { DSH_RUNTIME: 'bundled', DSH_BUNDLED_FETCH: '1', HARNESSDOCK_USE_SYSTEM_NODE: '0' },
        downloadImpl: async (input) => {
          expect(input.origin.dshVersion).toBe('0.1.1')
          return { dshBin: downloadedBin, runtimeDir: path.dirname(path.dirname(downloadedBin)) }
        },
        spawnImpl: (command, args, options) => {
          spawnCommand = command
          spawnArgs = args
          return spawn(process.execPath, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        },
      })

      try {
        await runtime.start()
      } finally {
        await runtime.stop()
      }
      expect(spawnCommand).toBe(path.join(bundledRoot, bundledNodeRel(process.platform)))
      expect(spawnArgs[0]).toBe(downloadedBin)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'falls back to the bundled seed when the pinned fetch fails (offline)',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bd-'))
      temps.push(dir)
      const bundledRoot = await fixtureBundledRoot(dir, '0.1.0')
      const fake = await fakeUrlScript(dir)
      const seedBin = bundledDshBin(bundledRoot)

      let spawnCommand = ''
      let spawnArgs: string[] = []
      const runtime = new DshRuntime({
        origin: { dshVersion: '0.1.1' },
        pluginPath: path.join(dir, 'plugin.js'),
        cacheDir: dir,
        bundledRoot,
        readyTimeoutMs: READY_TIMEOUT_MS,
        env: { DSH_RUNTIME: 'bundled', DSH_BUNDLED_FETCH: '1', HARNESSDOCK_USE_SYSTEM_NODE: '0' },
        downloadImpl: async () => {
          throw new Error('offline')
        },
        spawnImpl: (command, args, options) => {
          spawnCommand = command
          spawnArgs = args
          return spawn(process.execPath, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        },
      })

      try {
        await runtime.start()
      } finally {
        await runtime.stop()
      }
      expect(spawnCommand).toBe(path.join(bundledRoot, bundledNodeRel(process.platform)))
      expect(spawnArgs[0]).toBe(seedBin)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'does not fetch when the bundled seed already matches the pin',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bd-'))
      temps.push(dir)
      const bundledRoot = await fixtureBundledRoot(dir, '0.1.1')
      const fake = await fakeUrlScript(dir)

      let downloadCalled = false
      let spawnArgs: string[] = []
      const runtime = new DshRuntime({
        origin: { dshVersion: '0.1.1' },
        pluginPath: path.join(dir, 'plugin.js'),
        cacheDir: dir,
        bundledRoot,
        readyTimeoutMs: READY_TIMEOUT_MS,
        env: { DSH_RUNTIME: 'bundled' },
        downloadImpl: async () => {
          downloadCalled = true
          return { dshBin: '/unused', runtimeDir: '/unused' }
        },
        spawnImpl: (command, args, options) => {
          spawnArgs = args
          return spawn(process.execPath, [fake], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
        },
      })

      try {
        await runtime.start()
      } finally {
        await runtime.stop()
      }
      expect(downloadCalled).toBe(false)
      expect(spawnArgs[0]).toBe(bundledDshBin(bundledRoot))
    },
    TEST_TIMEOUT_MS,
  )
})
