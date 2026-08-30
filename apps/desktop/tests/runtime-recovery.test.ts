import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordRuntimeCrash } from '../src/runtime-recovery.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime crash budget', () => {
  it('uses bounded exponential backoff and stops automatic restart loops', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-runtime-recovery-'))
    roots.push(root)
    const file = path.join(root, 'crashes.json')
    const base = Date.parse('2026-08-30T00:00:00.000Z')
    const first = await recordRuntimeCrash(file, { now: new Date(base), maxRestarts: 3 })
    const second = await recordRuntimeCrash(file, { now: new Date(base + 1000), maxRestarts: 3 })
    const third = await recordRuntimeCrash(file, { now: new Date(base + 2000), maxRestarts: 3 })
    const fourth = await recordRuntimeCrash(file, { now: new Date(base + 3000), maxRestarts: 3 })
    expect([first.delayMs, second.delayMs, third.delayMs]).toEqual([1000, 2000, 4000])
    expect(first.allowed).toBe(true)
    expect(third.allowed).toBe(true)
    expect(fourth.allowed).toBe(false)
  })
})
