import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitHostUpdateHealth,
  defaultUpdateJournalPath,
  markHostUpdateInstalling,
  markHostUpdateVerifying,
  readHostUpdateRecovery,
  recordHostUpdateFailure,
  stageHostUpdateRecovery,
} from '../src/update-journal.ts'

const roots: string[] = []

async function tempJournal(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-update-journal-'))
  roots.push(root)
  return defaultUpdateJournalPath(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('host update recovery journal', () => {
  it('tracks staged -> installing -> verifying and commits only after health succeeds', async () => {
    const journal = await tempJournal()
    await stageHostUpdateRecovery(journal, {
      previousHostVersion: '0.1.1',
      targetHostVersion: '0.2.0',
      now: new Date('2026-08-30T00:00:00.000Z'),
    })
    expect((await readHostUpdateRecovery(journal))?.phase).toBe('staged')

    await markHostUpdateInstalling(journal, new Date('2026-08-30T00:01:00.000Z'))
    expect((await readHostUpdateRecovery(journal))?.phase).toBe('installing')

    const verifying = await markHostUpdateVerifying(journal, '0.2.0', {
      now: new Date('2026-08-30T00:02:00.000Z'),
      healthTimeoutMs: 60_000,
    })
    expect(verifying?.phase).toBe('verifying')
    expect(verifying?.attempt).toBe(1)
    expect(verifying?.healthDeadline).toBe('2026-08-30T00:03:00.000Z')

    expect(await commitHostUpdateHealth(journal, '0.2.0')).toBe(true)
    expect(await readHostUpdateRecovery(journal)).toBeNull()
  })

  it('does not mark the previous Host as a failed new version if install never switched', async () => {
    const journal = await tempJournal()
    await stageHostUpdateRecovery(journal, {
      previousHostVersion: '0.1.1',
      targetHostVersion: '0.2.0',
    })

    const record = await markHostUpdateVerifying(journal, '0.1.1')
    expect(record?.phase).toBe('staged')
    expect(record?.attempt).toBe(0)
    expect(await commitHostUpdateHealth(journal, '0.1.1')).toBe(false)
  })

  it('persists a sanitized failed health check for recovery decisions', async () => {
    const journal = await tempJournal()
    await stageHostUpdateRecovery(journal, {
      previousHostVersion: '0.1.1',
      targetHostVersion: '0.2.0',
    })
    await markHostUpdateVerifying(journal, '0.2.0')

    const failed = await recordHostUpdateFailure(journal, '0.2.0', new Error('dsh failed\nsecret-free detail'))
    expect(failed?.phase).toBe('failed')
    expect(failed?.attempt).toBe(1)
    expect(failed?.error).toBe('dsh failed secret-free detail')
  })
})
