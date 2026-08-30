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
  it('blocks a second live host and exposes canonical v2 ownership', async () => {
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
      endpoint: 'http://127.0.0.1:43123',
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
        ownerHost: 'electron',
        ownerPid: 101,
        host: 'electron',
        hostPid: 101,
        runtimePid: 202,
        runtimeId: 'runtime-1',
        endpoint: 'http://127.0.0.1:43123',
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
    expect(replacement.ownerHost).toBe('perry-desktop')
    await stale.release()
    expect(await inspectRuntimeLease(root)).toMatchObject({
      schemaVersion: 2,
      token: 'new-token',
      ownerHost: 'perry-desktop',
      ownerPid: 222,
      host: 'perry-desktop',
      hostPid: 222,
      protocolVersion: 1,
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
      ownerHost: 'perry-desktop',
      ownerPid: 333,
      host: 'perry-desktop',
      hostPid: 333,
      runtimePid: 444,
      dshVersion: '0.1.1',
      protocolVersion: 1,
      acquiredAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
    })
  })

  it('heartbeats active ownership without weakening token-safe release', async () => {
    const root = await tempRoot()
    let now = new Date('2026-08-30T00:00:00.000Z')
    const lease = await acquireRuntimeLease({
      host: 'tauri',
      hostPid: 555,
      leaseRoot: root,
      token: 'tauri-token',
      now: () => now,
      protocolVersion: 3,
      isPidAlive: () => true,
    })

    now = new Date('2026-08-30T00:00:10.000Z')
    await lease.heartbeat({ endpoint: 'http://127.0.0.1:43210' })
    expect(await inspectRuntimeLease(root)).toMatchObject({
      ownerHost: 'tauri',
      ownerPid: 555,
      endpoint: 'http://127.0.0.1:43210',
      protocolVersion: 3,
      updatedAt: '2026-08-30T00:00:10.000Z',
    })

    await lease.release()
    expect(await inspectRuntimeLease(root)).toBeNull()
  })
})
