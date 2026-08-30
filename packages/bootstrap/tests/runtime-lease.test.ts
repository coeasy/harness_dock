import { mkdtemp, rm } from 'node:fs/promises'
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

describe('runtime lease', () => {
  it('blocks another live desktop host and exposes the holder', async () => {
    const root = await tempRoot()
    const first = await acquireRuntimeLease({
      host: 'electron',
      hostPid: 101,
      leaseRoot: root,
      token: 'electron-token',
      isPidAlive: (pid) => pid === 101,
    })
    await first.updateRuntime({ runtimePid: 202, dshVersion: '0.1.0' })

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
      holder: expect.objectContaining({ host: 'electron', hostPid: 101, runtimePid: 202 }),
    } satisfies Partial<RuntimeLeaseConflictError>)

    await first.release()
    expect(await inspectRuntimeLease(root)).toBeNull()
  })

  it('allows Tauri to own the same cross-host lease contract', async () => {
    const root = await tempRoot()
    const tauri = await acquireRuntimeLease({
      host: 'tauri',
      hostPid: 404,
      leaseRoot: root,
      token: 'tauri-token',
      isPidAlive: (pid) => pid === 404,
    })
    await tauri.updateRuntime({ runtimePid: 505, dshVersion: '0.2.0-test' })
    expect(await inspectRuntimeLease(root)).toMatchObject({
      host: 'tauri',
      hostPid: 404,
      runtimePid: 505,
      dshVersion: '0.2.0-test',
    })
    await tauri.release()
  })

  it('reclaims a stale lease without letting an old handle delete the new owner', async () => {
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

    await stale.release()
    expect(await inspectRuntimeLease(root)).toMatchObject({
      token: 'new-token',
      host: 'perry',
      hostPid: 222,
    })

    await replacement.release()
    expect(await inspectRuntimeLease(root)).toBeNull()
  })
})
