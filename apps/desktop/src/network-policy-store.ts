import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  defaultNetworkProxyPolicy,
  normalizeNetworkProxyPolicy,
  type NetworkProxyPolicy,
} from '@dsh/bootstrap/client-core'

interface StoredNetworkPolicy {
  schemaVersion: 1
  policy: NetworkProxyPolicy
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export class JsonNetworkPolicyStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async load(): Promise<NetworkProxyPolicy> {
    return this.exclusive(async () => {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoredNetworkPolicy
        if (parsed?.schemaVersion !== 1) return defaultNetworkProxyPolicy()
        return normalizeNetworkProxyPolicy(parsed.policy)
      } catch {
        return defaultNetworkProxyPolicy()
      }
    })
  }

  async save(policy: NetworkProxyPolicy): Promise<NetworkProxyPolicy> {
    return this.exclusive(async () => {
      const normalized = normalizeNetworkProxyPolicy(policy)
      await writeAtomic(this.file, { schemaVersion: 1, policy: normalized } satisfies StoredNetworkPolicy)
      return normalized
    })
  }

  async reset(): Promise<NetworkProxyPolicy> {
    return this.exclusive(async () => {
      await rm(this.file, { force: true })
      return defaultNetworkProxyPolicy()
    })
  }
}

export function electronProxyConfigFromPolicy(policy: NetworkProxyPolicy): Electron.ProxyConfig {
  const normalized = normalizeNetworkProxyPolicy(policy)
  if (normalized.mode === 'system') return { mode: 'system' }
  if (normalized.mode === 'direct') return { mode: 'direct' }

  const endpoint = new URL(normalized.endpoint)
  const proxyRules = `${endpoint.protocol}//${endpoint.host}`
  return {
    mode: 'fixed_servers',
    proxyRules,
    ...(normalized.bypass?.length ? { proxyBypassRules: normalized.bypass.join(',') } : {}),
  }
}
