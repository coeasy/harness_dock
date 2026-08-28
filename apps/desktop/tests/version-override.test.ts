import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearVersionOverride,
  isAllowedVersion,
  listCachedRuntimeVersions,
  readVersionOverride,
  runtimeCacheDir,
  writeVersionOverride,
} from '../src/version-override.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vo-'))
  temps.push(dir)
  return dir
}

describe('isAllowedVersion', () => {
  const input = {
    pinned: '0.1.1-rc.2',
    seed: '0.1.0',
    cached: ['0.1.0', '0.2.0'],
  }

  it('allows the pinned version', () => {
    expect(isAllowedVersion('0.1.1-rc.2', input)).toBe(true)
  })

  it('allows the seed version (even when not cached)', () => {
    expect(isAllowedVersion('0.1.0', input)).toBe(true)
  })

  it('allows any cached runtime-* version', () => {
    expect(isAllowedVersion('0.2.0', input)).toBe(true)
  })

  it('rejects an arbitrary version that is neither pinned/seed/cached', () => {
    expect(isAllowedVersion('9.9.9', input)).toBe(false)
    expect(isAllowedVersion('', input)).toBe(false)
  })

  it('handles missing pinned/seed (empty allowlist)', () => {
    expect(isAllowedVersion('0.1.0', { cached: [] })).toBe(false)
  })
})

describe('listCachedRuntimeVersions', () => {
  it('lists runtime-* directory names with the prefix stripped, sorted', async () => {
    const dir = await tempDir()
    await mkdir(path.join(dir, 'runtime-0.2.0'))
    await mkdir(path.join(dir, 'runtime-0.1.0'))
    await mkdir(path.join(dir, 'runtime-0.10.0'))
    // non-runtime entries are ignored
    await mkdir(path.join(dir, 'other-dir'))
    await writeFile(path.join(dir, 'runtime-not-a-dir.txt'), 'x', 'utf8')

    expect(await listCachedRuntimeVersions(dir)).toEqual(['0.1.0', '0.2.0', '0.10.0'])
  })

  it('returns [] for a missing cache dir', async () => {
    const dir = await tempDir()
    expect(await listCachedRuntimeVersions(path.join(dir, 'nope'))).toEqual([])
  })
})

describe('version override persistence (injectable userData dir)', () => {
  it('writes, reads, and clears an override', async () => {
    const userData = await tempDir()
    expect(await readVersionOverride(userData)).toBeNull()

    await writeVersionOverride('0.2.0', userData)
    expect(await readVersionOverride(userData)).toBe('0.2.0')

    await clearVersionOverride(userData)
    expect(await readVersionOverride(userData)).toBeNull()
  })

  it('ignores a malformed override file', async () => {
    const userData = await tempDir()
    await writeFile(path.join(userData, 'origin-override.json'), 'not json', 'utf8')
    expect(await readVersionOverride(userData)).toBeNull()
  })
})

describe('runtimeCacheDir', () => {
  it('is userData/runtime-cache (bootstrap default)', () => {
    expect(runtimeCacheDir('C:/Users/me/.dsh')).toBe(path.join('C:/Users/me/.dsh', 'runtime-cache'))
  })
})
