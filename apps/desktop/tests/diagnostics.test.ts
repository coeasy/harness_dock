import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cacheSizeBytes, computeKeepSet, selectOldVersions, tailLines } from '../src/diagnostics/diagnostics.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('tailLines', () => {
  it('returns the last N lines', () => {
    const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
    const tail = tailLines(text, 200)
    const lines = tail.split('\n')
    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe('line 50')
    expect(lines[199]).toBe('line 249')
  })

  it('normalizes CRLF', () => {
    expect(tailLines('a\r\nb\r\nc', 2)).toBe('b\nc')
  })

  it('returns everything when shorter than the limit', () => {
    expect(tailLines('a\nb', 200)).toBe('a\nb')
  })

  it('keeps a single line', () => {
    expect(tailLines('only', 200)).toBe('only')
  })
})

describe('computeKeepSet / selectOldVersions', () => {
  it('keeps pinned / seed / current / override versions', () => {
    const keep = computeKeepSet({
      pinned: '0.1.1-rc.2',
      seed: '0.1.0',
      current: '0.2.0',
      override: '0.3.0',
    })
    expect(Array.from(keep).sort()).toEqual(['0.1.0', '0.1.1-rc.2', '0.2.0', '0.3.0'])
  })

  it('ignores undefined/null/empty values', () => {
    const keep = computeKeepSet({ pinned: '0.1.0', seed: null, current: undefined, override: '' })
    expect(Array.from(keep)).toEqual(['0.1.0'])
  })

  it('selects only cached versions NOT in the keep set', () => {
    const keep = computeKeepSet({ pinned: '0.1.0', seed: '0.1.0', current: '0.2.0' })
    const old = selectOldVersions(['0.1.0', '0.2.0', '0.9.9'], keep)
    expect(old).toEqual(['0.9.9'])
  })

  it('never deletes the currently running / pinned / seed versions', () => {
    const keep = computeKeepSet({ pinned: '0.1.1-rc.2', seed: '0.1.0', current: '0.2.0' })
    expect(selectOldVersions(['0.1.1-rc.2', '0.1.0', '0.2.0'], keep)).toEqual([])
  })
})

describe('cacheSizeBytes', () => {
  it('sums file sizes recursively and returns 0 for a missing dir', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sz-'))
    temps.push(dir)
    await mkdir(path.join(dir, 'a'))
    await mkdir(path.join(dir, 'a', 'b'))
    await writeFile(path.join(dir, 'one.bin'), '0123456789', 'utf8') // 10 bytes
    await writeFile(path.join(dir, 'a', 'two.bin'), '012345', 'utf8') // 6 bytes
    await writeFile(path.join(dir, 'a', 'b', 'three.bin'), '012345678901234', 'utf8') // 15 bytes

    expect(await cacheSizeBytes(dir)).toBe(31)
    expect(await cacheSizeBytes(path.join(dir, 'missing'))).toBe(0)
  })
})
