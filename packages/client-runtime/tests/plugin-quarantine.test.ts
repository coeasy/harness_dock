import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPluginQuarantine,
  readPluginQuarantine,
  writePluginQuarantine,
} from '../src/plugin-quarantine.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-plugin-quarantine-'))
  roots.push(root)
  return { root, file: path.join(root, 'quarantine.json') }
}

describe('plugin quarantine', () => {
  it('persists schema v2 ids and expires automatically', async () => {
    const { file } = await fixture()
    const now = new Date('2026-08-31T00:00:00.000Z')
    const record = await writePluginQuarantine(file, {
      dshVersion: '0.1.2-alpha.1',
      isolatedPlugins: ['legacy-a', 'legacy-b', 'legacy-a'],
      suspectedPlugins: ['legacy-a'],
      reason: 'diagnostic-match',
      now,
      ttlMs: 60_000,
    })
    expect(record).toMatchObject({
      schemaVersion: 2,
      dshBaseVersion: '0.1.2',
      isolatedPlugins: ['legacy-a', 'legacy-b'],
    })
    expect(await readPluginQuarantine(file, '0.1.2-alpha.1', new Date(now.getTime() + 30_000)))
      .toMatchObject({ isolatedPlugins: ['legacy-a', 'legacy-b'], suspectedPlugins: ['legacy-a'] })
    expect(await readPluginQuarantine(file, '0.1.2-alpha.1', new Date(now.getTime() + 60_001))).toBeNull()
  })

  it('survives prerelease-only upgrades and invalidates across base versions', async () => {
    const { file } = await fixture()
    const now = new Date()
    await writePluginQuarantine(file, {
      dshVersion: '0.1.2-rc.1',
      isolatedPlugins: ['legacy'],
      reason: 'ambiguous',
      now,
    })
    expect(await readPluginQuarantine(file, '0.1.2', new Date(now.getTime() + 1_000)))
      .toMatchObject({ dshBaseVersion: '0.1.2', isolatedPlugins: ['legacy'] })
    expect(await readPluginQuarantine(file, '0.1.2-rc.2', new Date(now.getTime() + 2_000)))
      .toMatchObject({ isolatedPlugins: ['legacy'] })
    expect(await readPluginQuarantine(file, '0.2.0', new Date(now.getTime() + 3_000))).toBeNull()
  })

  it('keeps legacy schema v1 exact-version semantics', async () => {
    const { file } = await fixture()
    const now = new Date()
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      dshVersion: '0.1.2-rc.1',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      isolatedPlugins: ['legacy'],
      suspectedPlugins: [],
      reason: 'ambiguous',
    }))
    expect(await readPluginQuarantine(file, '0.1.2-rc.1', new Date(now.getTime() + 1_000)))
      .toMatchObject({ schemaVersion: 2, isolatedPlugins: ['legacy'] })
    expect(await readPluginQuarantine(file, '0.1.2', new Date(now.getTime() + 2_000))).toBeNull()
  })

  it('rejects host-owned plugin ids at write time', async () => {
    const { file } = await fixture()
    await expect(writePluginQuarantine(file, {
      dshVersion: '0.1.2',
      isolatedPlugins: ['legacy', 'harness-shell'],
      reason: 'diagnostic-match',
    })).rejects.toThrow(/host-owned plugin/)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invalidates tampered state that tries to isolate a host-owned plugin', async () => {
    const { file } = await fixture()
    const now = new Date()
    await writeFile(file, JSON.stringify({
      schemaVersion: 2,
      dshVersion: '0.1.2',
      dshBaseVersion: '0.1.2',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      isolatedPlugins: ['embedded-client'],
      suspectedPlugins: ['embedded-client'],
      reason: 'diagnostic-match',
    }))
    expect(await readPluginQuarantine(file, '0.1.2')).toBeNull()
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can be explicitly cleared without touching user configuration', async () => {
    const { file } = await fixture()
    await writePluginQuarantine(file, {
      dshVersion: '0.1.2-alpha.1',
      isolatedPlugins: ['legacy'],
      reason: 'ambiguous',
    })
    await clearPluginQuarantine(file)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
