import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupOrigin, readPreviousOrigin } from '../src/rollback.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('backupOrigin / readPreviousOrigin (last-known-good)', () => {
  it('records a changed origin as the previous origin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bkp-'))
    temps.push(dir)
    const origin = path.join(dir, 'origin.json')
    const prev = path.join(dir, 'previous-origin.json')
    await writeFile(origin, `${JSON.stringify({ dshVersion: 'v2' })}\n`, 'utf8')
    await backupOrigin(origin, prev)
    expect(JSON.parse(await readFile(prev, 'utf8')).dshVersion).toBe('v2')
  })

  it('records the effective overridden Runtime rather than the older packaged origin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bkp-'))
    temps.push(dir)
    const origin = path.join(dir, 'origin.json')
    const prev = path.join(dir, 'previous-origin.json')
    await writeFile(origin, `${JSON.stringify({ dshVersion: 'v1', gitCommit: 'old' })}\n`, 'utf8')
    await backupOrigin(origin, prev, undefined, { dshVersion: 'v2', gitCommit: 'managed' })
    expect(JSON.parse(await readFile(prev, 'utf8'))).toMatchObject({
      dshVersion: 'v2',
      gitCommit: 'managed',
    })
  })

  it('keeps the existing backup when the version is unchanged', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bkp-'))
    temps.push(dir)
    const origin = path.join(dir, 'origin.json')
    const prev = path.join(dir, 'previous-origin.json')
    await writeFile(origin, `${JSON.stringify({ dshVersion: 'v2' })}\n`, 'utf8')
    await writeFile(prev, `${JSON.stringify({ dshVersion: 'v2' })}\n`, 'utf8')
    await backupOrigin(origin, prev)
    expect(JSON.parse(await readFile(prev, 'utf8')).dshVersion).toBe('v2')
  })

  it('returns the previous origin when it differs from the current version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bkp-'))
    temps.push(dir)
    const prev = path.join(dir, 'previous-origin.json')
    await writeFile(prev, `${JSON.stringify({ dshVersion: 'v1', npmPackage: '@deepseek-ai/dsh' })}\n`, 'utf8')
    const previous = await readPreviousOrigin(prev, 'v2')
    expect(previous?.dshVersion).toBe('v1')
    expect(previous?.origin.dshVersion).toBe('v1')
  })

  it('returns null when versions match or no backup exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bkp-'))
    temps.push(dir)
    const prev = path.join(dir, 'previous-origin.json')
    await writeFile(prev, `${JSON.stringify({ dshVersion: 'v1' })}\n`, 'utf8')
    expect(await readPreviousOrigin(prev, 'v1')).toBeNull()
    expect(await readPreviousOrigin(path.join(dir, 'missing.json'), 'v1')).toBeNull()
  })
})
