import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonNetworkPolicyStore,
  electronProxyConfigFromPolicy,
} from '../src/network-policy-store.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-network-policy-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('network policy store', () => {
  it('persists only validated non-secret proxy policy and round-trips it', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'network-policy.json')
    const store = new JsonNetworkPolicyStore(file)
    const saved = await store.save({
      mode: 'http',
      endpoint: 'http://proxy.example:8080',
      bypass: ['localhost', '*.internal'],
    })
    expect(await store.load()).toEqual(saved)
    const content = await readFile(file, 'utf8')
    expect(content).toContain('proxy.example')
    expect(content).not.toMatch(/password|username|secret/i)
  })

  it('fails safe to system policy when the persisted file is corrupt', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'network-policy.json')
    await writeFile(file, '{broken', 'utf8')
    const store = new JsonNetworkPolicyStore(file)
    expect(await store.load()).toEqual({ mode: 'system' })
  })

  it('maps normalized policy to Electron fixed_servers without credentials', () => {
    expect(
      electronProxyConfigFromPolicy({
        mode: 'socks5',
        endpoint: 'socks5://127.0.0.1:1080',
        bypass: ['localhost'],
      }),
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost',
    })
    expect(electronProxyConfigFromPolicy({ mode: 'system' })).toEqual({ mode: 'system' })
    expect(electronProxyConfigFromPolicy({ mode: 'direct' })).toEqual({ mode: 'direct' })
  })
})
