import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectProcessTree, isProcessAlive, resolveRuntimeMode, shutdownLadder } from '../src/process.ts'

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
    // 显式 DSH_RUNTIME 仍优先
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
    // mock taskkill manages its own alive-state; the mock child reports dead
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
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
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
    // Give Windows a moment to reap the pid
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isProcessAlive(child.pid)).toBe(false)
  })
})

describe('collectProcessTree', () => {
  it('returns descendants via the injected enumerator', async () => {
    const calls: string[] = []
    const fakeExec = (async (cmd: string, args: string[]) => {
      calls.push(args.join(' '))
      if (args[2].includes('ParentProcessId=100')) {
        return { stdout: 'ProcessId=200\r\nProcessId=201\r\n' }
      }
      if (args[2].includes('ParentProcessId=200')) {
        return { stdout: 'ProcessId=300\r\n' }
      }
      return { stdout: '' }
    }) as never
    const tree = await collectProcessTree(100, { exec: fakeExec, maxDepth: 3 })
    expect(tree.sort((a, b) => a - b)).toEqual([200, 201, 300])
  })

  it('returns [] when the enumerator fails', async () => {
    const fakeExec = (async () => {
      throw new Error('wmic unavailable')
    }) as never
    const tree = await collectProcessTree(100, { exec: fakeExec })
    expect(tree).toEqual([])
  })
})

describe('shutdownLadder verification sweep', () => {
  it('re-kills survivors that outlive the first force kill', async () => {
    const kills: Array<{ pid: number; force: boolean }> = []
    let dead = new Set<number>()
    const platform = 'win32'
    const child = { pid: 500 }

    await shutdownLadder(child, {
      termMs: 20,
      killMs: 20,
      platform,
      isAlive: () => !dead.has(500),
      taskkill: async (pid, force) => {
        kills.push({ pid, force })
        // The third force kill (round-1 sweep on pid 500) finally lands
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
      taskkill: async () => undefined, // never kills
      isProcessAlive: () => true,
      collectTree: async () => [601],
      verify: true,
    })
    expect(result.dead).toBe(false)
    expect(result.survivors).toEqual([600, 601])
  })
})

describe('ready file', () => {
  it('round-trips the ready payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ready-'))
    temps.push(dir)
    const file = path.join(dir, 'ready.json')
    const { parseReadyFile, writeReadyFile } = await import('../src/ready.ts')
    await writeReadyFile(file, {
      url: 'http://127.0.0.1:4010',
      host: '127.0.0.1',
      port: 4010,
      pid: 99,
      dshVersion: '0.1.1-rc.2',
    })
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw).url).toBe('http://127.0.0.1:4010')
    expect(parseReadyFile(raw)?.port).toBe(4010)
  })
})
