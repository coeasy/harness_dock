import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialStoreCorruptError,
  EncryptedCredentialFileStore,
  JsonSessionRecoveryService,
  type SecretCodec,
} from '../src/client-persistence.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-client-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const codec: SecretCodec = {
  encrypt(value) {
    return Buffer.from(`cipher:${value}`, 'utf8').toString('base64')
  },
  decrypt(value) {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    if (!decoded.startsWith('cipher:')) throw new Error('invalid ciphertext')
    return decoded.slice('cipher:'.length)
  },
}

describe('encrypted credential file store', () => {
  it('persists only codec output and supports atomic replace/get/list/delete', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'secure', 'credentials.json')
    const store = new EncryptedCredentialFileStore(file, codec)

    await store.set('provider-token', 'super-secret-value')
    await store.set('provider-token', 'rotated-secret-value')
    await store.set('proxy.main.username', 'alice')
    await store.set('proxy.main.password', 'secret')
    expect(await store.get('provider-token')).toBe('rotated-secret-value')
    expect(await store.list('proxy.main.')).toEqual(['proxy.main.password', 'proxy.main.username'])

    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).not.toContain('super-secret-value')
    expect(onDisk).not.toContain('rotated-secret-value')
    expect(onDisk).not.toContain('alice')
    expect(onDisk).toContain('schemaVersion')

    await store.delete('provider-token')
    expect(await store.get('provider-token')).toBeNull()
  })

  it('expires OAuth pending state and removes invalid legacy values fail-closed', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'secure', 'credentials.json')
    let now = 1_000
    const store = new EncryptedCredentialFileStore(file, codec, () => now, 500)
    await store.set('oauth.pending.nonce-1', '/session/1')
    expect(await store.get('oauth.pending.nonce-1')).toBe('/session/1')
    now = 1_501
    expect(await store.get('oauth.pending.nonce-1')).toBeNull()
    expect(await store.list('oauth.pending.')).toEqual([])
  })

  it('fails closed on corrupt credential metadata', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'credentials.json')
    await writeFile(file, '{"schemaVersion":99,"entries":{}}\n', 'utf8')
    const store = new EncryptedCredentialFileStore(file, codec)
    await expect(store.get('token')).rejects.toBeInstanceOf(CredentialStoreCorruptError)
  })
})

describe('session recovery store', () => {
  it('atomically round-trips the stable snapshot schema', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'session.json')
    const recovery = new JsonSessionRecoveryService(file)
    const snapshot = {
      schemaVersion: 1 as const,
      route: '/sessions/current',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runtimeVersion: '0.1.1',
      savedAt: '2026-08-30T05:00:00.000Z',
    }

    await recovery.save(snapshot)
    expect(await recovery.load()).toEqual(snapshot)
    await recovery.save({ ...snapshot, runtimeVersion: '0.1.2', savedAt: '2026-08-30T05:01:00.000Z' })
    expect(await recovery.load()).toMatchObject({ runtimeVersion: '0.1.2' })
    await recovery.clear()
    expect(await recovery.load()).toBeNull()
  })

  it('treats malformed recovery data as unavailable instead of crashing boot', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'session.json')
    await writeFile(file, '{broken json', 'utf8')
    const recovery = new JsonSessionRecoveryService(file)
    expect(await recovery.load()).toBeNull()
  })
})
