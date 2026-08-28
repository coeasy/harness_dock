import { describe, expect, it } from 'vitest'
import { installClosure, type PlanEntry } from '../src/fetch-runtime.ts'

const entry = (name: string): PlanEntry => ({ name, version: '1.0.0', meta: {} })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('installClosure concurrency', () => {
  it('installs every package with bounded concurrency and monotonic progress', async () => {
    const plan = Array.from({ length: 12 }, (_, i) => entry(`pkg-${i}`))
    const names = plan.map((p) => p.name)
    let active = 0
    let peak = 0
    const installed: string[] = []
    const doneValues: number[] = []
    const totals = new Set<number>()

    await installClosure(
      [],
      'node_modules',
      {},
      {
        concurrency: 3,
        resolve: async () => plan,
        download: async (e) => {
          active += 1
          peak = Math.max(peak, active)
          await sleep(10)
          active -= 1
          return Buffer.from(`data-${e.name}`)
        },
        extract: async (_buffer, _nodeModules, name) => {
          installed.push(name)
        },
        onProgress: (event) => {
          if (event.stage === 'fetch') {
            doneValues.push(event.done)
            totals.add(event.total)
          }
        },
      },
    )

    // every package was installed exactly once
    expect(installed.sort()).toEqual([...names].sort())
    // the pool actually ran in parallel, but never above the configured cap
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
    // every progress event reported the same, correct total
    expect(totals.size).toBe(1)
    expect([...totals][0]).toBe(plan.length)
    // one event per package, done monotonically increasing up to total
    expect(doneValues).toHaveLength(plan.length)
    expect(doneValues).toEqual([...doneValues].sort((a, b) => a - b))
    expect(doneValues.at(-1)).toBe(plan.length)
  })

  it('honors the DSH_DOWNLOAD_CONCURRENCY env override', async () => {
    const plan = Array.from({ length: 8 }, (_, i) => entry(`dep-${i}`))
    let active = 0
    let peak = 0
    await installClosure(
      [],
      'node_modules',
      { DSH_DOWNLOAD_CONCURRENCY: '2' },
      {
        resolve: async () => plan,
        download: async () => {
          active += 1
          peak = Math.max(peak, active)
          await sleep(10)
          active -= 1
          return Buffer.from('x')
        },
        extract: async () => undefined,
      },
    )
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('throws when a package fails, keeping successful installs intact', async () => {
    const plan = [entry('ok-1'), entry('boom'), entry('ok-2')]
    const installed: string[] = []
    await expect(
      installClosure(
        [],
        'node_modules',
        {},
        {
          concurrency: 2,
          resolve: async () => plan,
          download: async (e) => {
            // the failing package takes long enough for the healthy ones to
            // fully install first, so the partial-install semantics are stable
            if (e.name === 'boom') {
              await sleep(20)
              throw new Error('download failed')
            }
            return Buffer.from('x')
          },
          extract: async (_buffer, _nodeModules, name) => {
            installed.push(name)
          },
        },
      ),
    ).rejects.toThrow('download failed')
    // packages that completed before the failure stay installed
    expect(installed.sort()).toEqual(['ok-1', 'ok-2'])
    expect(installed).not.toContain('boom')
  })

  it('reports resolve progress through onProgress (done increments)', async () => {
    const plan = [entry('a'), entry('b'), entry('c')]
    const resolveEvents: number[] = []
    await installClosure(
      [],
      'node_modules',
      {},
      {
        resolve: async (_specs, _env, _timeoutMs, onResolve) => {
          for (let i = 1; i <= plan.length; i += 1) onResolve?.(i)
          return plan
        },
        download: async () => Buffer.from('x'),
        extract: async () => undefined,
        onProgress: (event) => {
          if (event.stage === 'resolve') resolveEvents.push(event.done ?? -1)
        },
      },
    )
    expect(resolveEvents).toEqual([1, 2, 3, 3])
  })

  it('retries a flaky package before giving up', async () => {
    const plan = [entry('flaky'), entry('good')]
    const downloads: Record<string, number> = {}
    const installed: string[] = []
    await installClosure(
      [],
      'node_modules',
      {},
      {
        retries: 3,
        resolve: async () => plan,
        download: async (e) => {
          downloads[e.name] = (downloads[e.name] ?? 0) + 1
          if (e.name === 'flaky' && downloads[e.name] < 2) throw new Error('transient')
          return Buffer.from('x')
        },
        extract: async (_buffer, _nodeModules, name) => {
          installed.push(name)
        },
      },
    )
    expect(downloads['flaky']).toBe(2)
    expect(installed.sort()).toEqual(['flaky', 'good'])
  })

  it('throws after exhausting retries', async () => {
    const plan = [entry('doomed')]
    let calls = 0
    await expect(
      installClosure(
        [],
        'node_modules',
        {},
        {
          retries: 2,
          resolve: async () => plan,
          download: async () => {
            calls += 1
            throw new Error('always fails')
          },
          extract: async () => undefined,
        },
      ),
    ).rejects.toThrow('always fails')
    expect(calls).toBe(2)
  })
})
