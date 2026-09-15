import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

describe('plugin quarantine', () => {
  it('persists only plugin ids and expires automatically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-plugin-quarantine-'))
    roots.push(root)
    const file = path.join(root, 'quarantine.json')
    const now = new Date('2026-08-31T00:00:00.000Z')
    const record = await writePluginQuarantine(file, {
      dshVersion: '0.1.2-alpha.1',
      isolatedPlugins: ['legacy-a', 'legacy-b', 'legacy-a'],
      suspectedPlugins: ['legacy-a'],
      reason: 'diagnostic-match',
      now,
      ttlMs: 60_000,
    })
    expect(record.isolatedPlugins).toEqual(['legacy-a', 'legacy-b'])
    expect(await readPluginQuarantine(file, '0.1.2-alpha.1', new Date(now.getTime() + 30_000)))
      .toMatchObject({ isolatedPlugins: ['legacy-a', 'legacy-b'], suspectedPlugins: ['legacy-a'] })
    expect(await readPluginQuarantine(file, '0.1.2-alpha.1', new Date(now.getTime() + 60_001))).toBeNull()
  })

  it('invalidates quarantine when the dsh version changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-plugin-quarantine-'))
    roots.push(root)
    const file = path.join(root, 'quarantine.json')
    await writePluginQuarantine(file, {
      dshVersion: 'old',
      isolatedPlugins: ['legacy'],
      reason: 'ambiguous',
    })
    expect(await readPluginQuarantine(file, 'new')).toBeNull()
  })

  it('can be explicitly cleared without touching user configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-plugin-quarantine-'))
    roots.push(root)
    const file = path.join(root, 'quarantine.json')
    await writePluginQuarantine(file, {
      dshVersion: '0.1.2-alpha.1',
      isolatedPlugins: ['legacy'],
      reason: 'ambiguous',
    })
    await clearPluginQuarantine(file)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
