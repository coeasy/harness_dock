import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectProcessTree,
  collectProcessTreeViaPs,
  isProcessAlive,
  resolveRuntimeMode,
  shutdownLadder,
} from '../src/process.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveRuntimeMode', () => {
  it('defaults to local in development and download in packaged builds', () => {
    expect(resolveRuntimeMode({ env: {}, packaged: false })).toBe('local')
    expect(resolveRuntimeMode({ env: {}, packaged: true })).toBe('download')
    expect(resolveRuntimeMode({ env: { DSH_RUNTIME: 'bundled' }, packaged: true })).toBe(
      'bundled',
    )
    expect(resolveRuntimeMode({ env: {}, packaged: true, bundledAvailable: true })).toBe(
      'bundled',
    )
  })

  it('prefers bundled runtime in development when it is available', () => {
    expect(resolveRuntimeMode({ env: {}, packaged: false, bundledAvailable: true })).toBe(
      'bundled',
    )
    expect(
      resolveRuntimeMode({ env: { DSH_RUNTIME: 'local' }, packaged: false, bundledAvailable: true }),
    ).toBe('local')
  })

  it('rejects latest as a runtime version override', () => {
    expect(() =>
      resolveRuntimeMode({ env: { DSH_RUNTIME_VERSION: 'latest' }, packaged: false }),
    ).toThrow(/dist-tag/)
  })
})

describe('shutdownLadder', () => {
  it('uses taskkill on Windows instead of POSIX signals', async () => {
    const calls: Array<{ pid: number; force: boolean }> = []
    const child = {
      pid: 77,
      kill() {
        throw new Error('kill() must not be used on win32')
      },
    }
    let alive = true
    await shutdownLadder(child, {
      termMs: 20,
      killMs: 20,
      isAlive: () => alive,
      platform: 'win32',
      taskkill: async (pid, force) => {
        calls.push({ pid, force })
        if (force) alive = false
      },
    })
    expect(calls).toEqual([
      { pid: 77, force: false },
      { pid: 77, force: true },
    ])
    expect(alive).toBe(false)
  })

  it('escalates immediately when the Windows graceful tree request is rejected', async () => {
    const calls: Array<{ pid: number; force: boolean }> = []
    const signals: string[] = []
    let alive = true
    let livenessChecks = 0
    const child = {
      pid: 78,
      kill(signal?: NodeJS.Signals) {
        signals.push(signal ?? 'SIGTERM')
        return true
      },
    }

    const result = await shutdownLadder(child, {
      termMs: 5_000,
      killMs: 20,
      isAlive: () => {
        livenessChecks += 1
        return alive
      },
      platform: 'win32',
      taskkill: async (pid, force) => {
        calls.push({ pid, force })
        if (!force) throw new Error('console process requires force')
        alive = false
      },
    })

    expect(result).toEqual({ dead: true, survivors: [] })
    expect(calls).toEqual([
      { pid: 78, force: false },
      { pid: 78, force: true },
    ])
    expect(signals).toEqual([])
    expect(livenessChecks).toBeLessThanOrEqual(3)
  })

  it('sends SIGTERM then SIGKILL if the child stays alive', async () => {
    const signals: string[] = []
    const child = {
      pid: 4242,
      killed: false,
      kill(signal?: NodeJS.Signals) {
        signals.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') this.killed = true
        return true
      },
    }
    await shutdownLadder(child, {
      termMs: 20,
      killMs: 20,
      isAlive: () => !child.killed,
      platform: 'linux',
      collectTree: async () => [],
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('drains POSIX descendants instead of declaring success when only the root exits', async () => {
    const alive = new Set([7000, 7001, 7002])
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const child = {
      pid: 7000,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        signals.push({ pid: 7000, signal })
        if (signal === 'SIGKILL') alive.delete(7000)
        return true
      },
    }

    const result = await shutdownLadder(child, {
      termMs: 20,
      killMs: 20,
      platform: 'linux',
      isAlive: () => alive.has(7000),
      isProcessAlive: (pid) => alive.has(pid),
      collectTree: async () => [7001, 7002],
      killPid: (pid, signal) => {
        signals.push({ pid, signal })
        if (signal === 'SIGKILL') alive.delete(pid)
      },
    })

    expect(result).toEqual({ dead: true, survivors: [] })
    expect(signals).toEqual(expect.arrayContaining([
      { pid: 7001, signal: 'SIGTERM' },
      { pid: 7002, signal: 'SIGTERM' },
      { pid: 7000, signal: 'SIGTERM' },
      { pid: 7001, signal: 'SIGKILL' },
      { pid: 7002, signal: 'SIGKILL' },
      { pid: 7000, signal: 'SIGKILL' },
    ]))
  })
})

describe('isProcessAlive', () => {
  it('treats missing/invalid pids as dead', () => {
    expect(isProcessAlive(undefined)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('reports a terminated child as dead', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isProcessAlive(child.pid)).toBe(false)
  })
})

describe('collectProcessTree', () => {
  it('returns Windows descendants via the injected enumerator', async () => {
    const fakeExec = (async (_cmd: string, args: string[]) => {
      if (args[2].includes('ParentProcessId=100')) {
        return { stdout: 'ProcessId=200\r\nProcessId=201\r\n' }
      }
      if (args[2].includes('ParentProcessId=200')) {
        return { stdout: 'ProcessId=300\r\n' }
      }
      return { stdout: '' }
    }) as never
    const tree = await collectProcessTree(100, {
      exec: fakeExec,
      maxDepth: 3,
      platform: 'win32',
    })
    expect(tree.sort((a, b) => a - b)).toEqual([200, 201, 300])
  })

  it('returns [] when every Windows enumerator fails', async () => {
    const fakeExec = (async () => {
      throw new Error('enumerator unavailable')
    }) as never
    const tree = await collectProcessTree(100, { exec: fakeExec, platform: 'win32' })
    expect(tree).toEqual([])
  })

  it('builds a POSIX subtree from a single ps snapshot', async () => {
    const fakeExec = (async (cmd: string, args: string[]) => {
      expect(cmd).toBe('ps')
      expect(args).toEqual(['-eo', 'pid=,ppid='])
      return {
        stdout: [
          '100 1',
          '200 100',
          '201 100',
          '300 200',
          '400 999',
        ].join('\n'),
      }
    }) as never
    const tree = await collectProcessTreeViaPs(100, { exec: fakeExec, maxDepth: 3 })
    expect(tree.sort((a, b) => a - b)).toEqual([200, 201, 300])
  })
})

describe('shutdownLadder verification sweep', () => {
  it('re-kills survivors that outlive the first force kill', async () => {
    const kills: Array<{ pid: number; force: boolean }> = []
    const dead = new Set<number>()
    const child = { pid: 500 }

    await shutdownLadder(child, {
      termMs: 20,
      killMs: 20,
      platform: 'win32',
      isAlive: () => !dead.has(500),
      taskkill: async (pid, force) => {
        kills.push({ pid, force })
        if (kills.filter((k) => k.pid === pid && k.force).length >= 2) {
          dead.add(pid)
        }
      },
      isProcessAlive: (pid) => !dead.has(pid),
      collectTree: async () => [],
      verify: true,
    })

    expect(dead.has(500)).toBe(true)
    expect(kills.some((k) => k.force)).toBe(true)
  })

  it('reports survivors that refuse to die', async () => {
    const child = { pid: 600 }
    const result = await shutdownLadder(child, {
      termMs: 10,
      killMs: 10,
      platform: 'win32',
      isAlive: () => true,
      taskkill: async () => undefined,
      isProcessAlive: () => true,
      collectTree: async () => [601],
      verify: true,
    })
    expect(result.dead).toBe(false)
    expect(result.survivors).toEqual([600, 601])
  })
})

describe('ready file', () => {
  it('accepts only a complete generation-bound ready payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ready-'))
    temps.push(dir)
    const file = path.join(dir, 'ready.json')
    const { parseReadyFile } = await import('../src/ready.ts')
    const expected = {
      dshVersion: '0.1.1-rc.2',
      pid: 99,
      generation: 7,
      nonce: 'nonce-7',
      imageIdentity: 'image-identity-7',
    }
    const payload = {
      url: 'http://127.0.0.1:4010',
      host: '127.0.0.1',
      port: 4010,
      ...expected,
    }
    await writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8')
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw).url).toBe('http://127.0.0.1:4010')
    expect(parseReadyFile(raw, expected)?.port).toBe(4010)
    expect(parseReadyFile(raw, { ...expected, nonce: 'wrong' })).toBeNull()
  })
})
