import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RuntimeLeaseConflictError,
  acquireRuntimeLease,
  inspectRuntimeLease,
} from '../src/runtime-lease.ts'

const dirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-lease-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('runtime lease v2', () => {
  it('blocks a second live host and exposes normalized v2 ownership', async () => {
    const root = await tempRoot()
    const first = await acquireRuntimeLease({
      host: 'electron',
      hostPid: 101,
      leaseRoot: root,
      token: 'electron-token',
      isPidAlive: (pid) => pid === 101,
    })
    await first.updateRuntime({
      runtimePid: 202,
      runtimeId: 'runtime-1',
      dshVersion: '0.1.1',
      protocolVersion: 2,
    })

    await expect(
      acquireRuntimeLease({
        host: 'tauri',
        hostPid: 303,
        leaseRoot: root,
        token: 'tauri-token',
        isPidAlive: (pid) => pid === 101,
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeLeaseConflictError',
      holder: expect.objectContaining({
        schemaVersion: 2,
        host: 'electron',
        hostPid: 101,
        runtimePid: 202,
        runtimeId: 'runtime-1',
        protocolVersion: 2,
      }),
    } satisfies Partial<RuntimeLeaseConflictError>)

    await first.release()
    expect(await inspectRuntimeLease(root)).toBeNull()
  })

  it('normalizes the legacy Perry host name and protects replacement owners', async () => {
    const root = await tempRoot()
    const stale = await acquireRuntimeLease({
      host: 'electron',
      hostPid: 111,
      leaseRoot: root,
      token: 'stale-token',
      isPidAlive: () => true,
    })

    const replacement = await acquireRuntimeLease({
      host: 'perry',
      hostPid: 222,
      leaseRoot: root,
      token: 'new-token',
      isPidAlive: () => false,
    })

    expect(replacement.host).toBe('perry-desktop')
    await stale.release()
    expect(await inspectRuntimeLease(root)).toMatchObject({
      schemaVersion: 2,
      token: 'new-token',
      host: 'perry-desktop',
      hostPid: 222,
    })

    await replacement.release()
    expect(await inspectRuntimeLease(root)).toBeNull()
  })

  it('reads v0.1 schemaVersion 1 locks so upgrades can report or reclaim them', async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    const legacy = {
      schemaVersion: 1,
      token: 'legacy-token',
      host: 'perry',
      hostPid: 333,
      runtimePid: 444,
      dshVersion: '0.1.1',
      acquiredAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
    }
    await writeFile(path.join(root, 'runtime.lock'), `${JSON.stringify(legacy)}\n`, 'utf8')
    await writeFile(path.join(root, 'active.json'), `${JSON.stringify(legacy)}\n`, 'utf8')

    expect(await inspectRuntimeLease(root)).toEqual({
      schemaVersion: 2,
      token: 'legacy-token',
      host: 'perry-desktop',
      hostPid: 333,
      runtimePid: 444,
      dshVersion: '0.1.1',
      acquiredAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
    })
  })
})
