import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  matchesIntegrity,
  resolveTarballCandidates,
  tarballUrlFor,
  withTimeout,
} from '../src/npm-mirrors.ts'

describe('withTimeout', () => {
  it('rejects with a hard deadline when the promise never settles', async () => {
    const never = new Promise<never>(() => {
      // never resolves/rejects
    })
    await expect(withTimeout(never, 30, 'test')).rejects.toThrow('timed out after 30ms')
  })

  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'test')).resolves.toBe('ok')
  })

  it('propagates the underlying rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1_000, 'test'),
    ).rejects.toThrow('boom')
  })
})

describe('npm-mirrors', () => {
  it('builds registry-style tarball urls for scoped packages', () => {
    expect(tarballUrlFor('https://registry.npmjs.org', '@deepseek-ai/dsh', '0.1.1-rc.2')).toBe(
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz',
    )
    expect(tarballUrlFor('https://registry.npmmirror.com/', 'lodash', '4.17.21')).toBe(
      'https://registry.npmmirror.com/lodash/-/lodash-4.17.21.tgz',
    )
  })

  it('orders candidates: env override, origin pin, intranet mirror, default registries', () => {
    const candidates = resolveTarballCandidates(
      {
        npmPackage: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
        npmTarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz',
      },
      { DSH_NPM_MIRROR: 'https://nexus.corp.internal/repository/npm-proxy' },
    )
    // origin pin points at the official registry URL, so the identical mirror
    // candidate is de-duplicated away.
    expect(candidates.map((c) => c.source)).toEqual(['origin', 'mirror', 'mirror'])
    expect(candidates[1].url).toContain('nexus.corp.internal')
    expect(candidates.at(-1)?.url).toContain('registry.npmmirror.com')
  })

  it('puts explicit DSH_NPM_TARBALL_URL before everything', () => {
    const candidates = resolveTarballCandidates(
      { npmPackage: '@deepseek-ai/dsh', version: '1.0.0' },
      { DSH_NPM_TARBALL_URL: 'https://files.example.internal/dsh.tgz' },
    )
    expect(candidates[0]).toEqual({
      url: 'https://files.example.internal/dsh.tgz',
      source: 'env',
    })
  })

  it('verifies sha512 integrity like npm', () => {
    const good = Buffer.from('hello world')
    const digest = `sha512-${createHash('sha512').update(good).digest('base64')}`
    expect(matchesIntegrity(good, digest)).toBe(true)
    expect(matchesIntegrity(Buffer.from('tampered'), digest)).toBe(false)
    expect(matchesIntegrity(good, undefined)).toBe(true)
  })

  it('rejects malformed integrity strings', () => {
    expect(matchesIntegrity(Buffer.from('x'), 'not-a-valid-integrity')).toBe(false)
  })
})
