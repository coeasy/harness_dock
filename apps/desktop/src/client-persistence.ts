import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClientSessionSnapshot, CredentialService, SessionRecoveryService } from '@dsh/bootstrap/client-core'

export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

interface CredentialFileV1 {
  schemaVersion: 1
  entries: Record<string, string>
}

interface ExpiringCredentialV1 {
  schemaVersion: 1
  value: string
  expiresAt: number
}

const OAUTH_PENDING_PREFIX = 'oauth.pending.'
const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60_000

export class CredentialStoreCorruptError extends Error {
  constructor(readonly file: string) {
    super(`Encrypted credential store is corrupt: ${file}`)
    this.name = 'CredentialStoreCorruptError'
  }
}

async function writeAtomic(file: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode })
    await rename(tmp, file)
    await chmod(file, mode).catch(() => undefined)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export class EncryptedCredentialFileStore implements CredentialService {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec,
    private readonly now: () => number = () => Date.now(),
    private readonly oauthStateTtlMs = DEFAULT_OAUTH_STATE_TTL_MS,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async readStore(): Promise<CredentialFileV1> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as CredentialFileV1
      if (
        parsed?.schemaVersion !== 1 ||
        !parsed.entries ||
        typeof parsed.entries !== 'object' ||
        Array.isArray(parsed.entries) ||
        Object.values(parsed.entries).some((value) => typeof value !== 'string')
      ) {
        throw new CredentialStoreCorruptError(this.file)
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, entries: {} }
      }
      if (error instanceof CredentialStoreCorruptError) throw error
      if (error instanceof SyntaxError) throw new CredentialStoreCorruptError(this.file)
      throw error
    }
  }

  private async persistStore(store: CredentialFileV1): Promise<void> {
    if (Object.keys(store.entries).length === 0) {
      await rm(this.file, { force: true })
      return
    }
    await writeAtomic(this.file, `${JSON.stringify(store, null, 2)}\n`)
  }

  private assertKey(key: string): void {
    if (!key.trim() || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error('Credential key must be 1-256 printable characters')
    }
  }

  private encodeValue(key: string, value: string): string {
    if (!key.startsWith(OAUTH_PENDING_PREFIX)) return value
    const envelope: ExpiringCredentialV1 = {
      schemaVersion: 1,
      value,
      expiresAt: this.now() + this.oauthStateTtlMs,
    }
    return JSON.stringify(envelope)
  }

  private decodeExpiringValue(value: string): ExpiringCredentialV1 | null {
    try {
      const parsed = JSON.parse(value) as Partial<ExpiringCredentialV1>
      if (
        parsed.schemaVersion !== 1 ||
        typeof parsed.value !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        !Number.isFinite(parsed.expiresAt)
      ) return null
      return parsed as ExpiringCredentialV1
    } catch {
      return null
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertKey(key)
    return this.exclusive(async () => {
      const store = await this.readStore()
      const encrypted = store.entries[key]
      if (encrypted === undefined) return null
      const plain = this.codec.decrypt(encrypted)
      if (!key.startsWith(OAUTH_PENDING_PREFIX)) return plain
      const envelope = this.decodeExpiringValue(plain)
      if (!envelope || envelope.expiresAt <= this.now()) {
        delete store.entries[key]
        await this.persistStore(store)
        return null
      }
      return envelope.value
    })
  }

  async set(key: string, value: string): Promise<void> {
    this.assertKey(key)
    return this.exclusive(async () => {
      const store = await this.readStore()
      store.entries[key] = this.codec.encrypt(this.encodeValue(key, value))
      await this.persistStore(store)
    })
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key)
    return this.exclusive(async () => {
      const store = await this.readStore()
      if (!(key in store.entries)) return
      delete store.entries[key]
      await this.persistStore(store)
    })
  }

  async list(prefix = ''): Promise<readonly string[]> {
    if (prefix.length > 256 || /[\u0000-\u001f\u007f]/.test(prefix)) {
      throw new Error('Credential prefix must be at most 256 printable characters')
    }
    return this.exclusive(async () => {
      const store = await this.readStore()
      return Object.keys(store.entries)
        .filter((key) => key.startsWith(prefix))
        .sort((a, b) => a.localeCompare(b))
    })
  }
}

function normalizeSessionSnapshot(value: unknown): ClientSessionSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Record<string, unknown>
  if (snapshot.schemaVersion !== 1 || typeof snapshot.savedAt !== 'string') return null
  for (const key of ['route', 'sessionId', 'workspaceId', 'runtimeVersion'] as const) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string') return null
  }
  return {
    schemaVersion: 1,
    ...(typeof snapshot.route === 'string' ? { route: snapshot.route } : {}),
    ...(typeof snapshot.sessionId === 'string' ? { sessionId: snapshot.sessionId } : {}),
    ...(typeof snapshot.workspaceId === 'string' ? { workspaceId: snapshot.workspaceId } : {}),
    ...(typeof snapshot.runtimeVersion === 'string' ? { runtimeVersion: snapshot.runtimeVersion } : {}),
    savedAt: snapshot.savedAt,
  }
}

export class JsonSessionRecoveryService implements SessionRecoveryService {
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

  async save(snapshot: ClientSessionSnapshot): Promise<void> {
    return this.exclusive(async () => {
      const normalized = normalizeSessionSnapshot(snapshot)
      if (!normalized) throw new Error('Invalid client session snapshot')
      await writeAtomic(this.file, `${JSON.stringify(normalized, null, 2)}\n`)
    })
  }

  async load(): Promise<ClientSessionSnapshot | null> {
    return this.exclusive(async () => {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
        return normalizeSessionSnapshot(parsed)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        if (error instanceof SyntaxError) return null
        throw error
      }
    })
  }

  async clear(): Promise<void> {
    return this.exclusive(async () => {
      await rm(this.file, { force: true })
    })
  }
}
