import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DshRuntime } from '../src/runtime.ts'
import { bundledDshBin } from '../src/bundled.ts'

const temps: string[] = []

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
  await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(path.join(root, 'node.exe'), '')
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
        readyTimeoutMs: 15_000,
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
    20_000,
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
        origin: { dshVersion: '0.1.1' }, // != seed 0.1.0 -> follow-pin must trigger
        pluginPath: path.join(dir, 'plugin.js'),
        cacheDir: dir,
        bundledRoot,
        readyTimeoutMs: 15_000,
        env: { DSH_RUNTIME: 'bundled' },
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
      // bundled node runs the *downloaded* pinned dsh bin
      expect(spawnCommand).toBe(path.join(bundledRoot, 'node.exe'))
      expect(spawnArgs[0]).toBe(downloadedBin)
    },
    20_000,
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
        readyTimeoutMs: 15_000,
        env: { DSH_RUNTIME: 'bundled' },
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
      // fetch failed -> run the bundled seed as-is
      expect(spawnCommand).toBe(path.join(bundledRoot, 'node.exe'))
      expect(spawnArgs[0]).toBe(seedBin)
    },
    20_000,
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
        origin: { dshVersion: '0.1.1' }, // == seed
        pluginPath: path.join(dir, 'plugin.js'),
        cacheDir: dir,
        bundledRoot,
        readyTimeoutMs: 15_000,
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
    20_000,
  )
})
