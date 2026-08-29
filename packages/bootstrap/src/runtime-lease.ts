import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultSharedStateDir, type DesktopHostKind } from './host.ts'

export interface RuntimeLeaseRecord {
  schemaVersion: 1
  token: string
  host: DesktopHostKind
  hostPid: number
  runtimePid?: number
  dshVersion?: string
  acquiredAt: string
  updatedAt: string
}

export interface AcquireRuntimeLeaseOptions {
  host: DesktopHostKind
  hostPid?: number
  leaseRoot?: string
  isPidAlive?: (pid: number) => boolean
  now?: () => Date
  token?: string
}

export interface RuntimeLeaseHandle {
  readonly root: string
  readonly host: DesktopHostKind
  readonly token: string
  readonly record: RuntimeLeaseRecord
  updateRuntime(info: { runtimePid?: number; dshVersion?: string }): Promise<void>
  release(): Promise<void>
}

export class RuntimeLeaseConflictError extends Error {
  readonly holder: RuntimeLeaseRecord | null

  constructor(holder: RuntimeLeaseRecord | null) {
    const detail = holder
      ? `${holder.host} host pid=${holder.hostPid}${holder.dshVersion ? ` dsh=${holder.dshVersion}` : ''}`
      : 'another HarnessDock host'
    super(`HarnessDock runtime is already owned by ${detail}`)
    this.name = 'RuntimeLeaseConflictError'
    this.holder = holder
  }
}

export function defaultRuntimeLeaseRoot(): string {
  return path.join(defaultSharedStateDir(), 'runtime')
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readRecord(file: string): Promise<RuntimeLeaseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as RuntimeLeaseRecord
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.token !== 'string' ||
      (parsed.host !== 'electron' && parsed.host !== 'perry') ||
      !Number.isInteger(parsed.hostPid)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeActiveAtomic(file: string, record: RuntimeLeaseRecord): Promise<void> {
  const tmp = `${file}.${record.token}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export async function inspectRuntimeLease(
  leaseRoot = defaultRuntimeLeaseRoot(),
): Promise<RuntimeLeaseRecord | null> {
  const active = await readRecord(path.join(leaseRoot, 'active.json'))
  if (active) return active
  return readRecord(path.join(leaseRoot, 'runtime.lock'))
}

export async function acquireRuntimeLease(
  options: AcquireRuntimeLeaseOptions,
): Promise<RuntimeLeaseHandle> {
  const root = path.resolve(options.leaseRoot ?? defaultRuntimeLeaseRoot())
  const lockPath = path.join(root, 'runtime.lock')
  const activePath = path.join(root, 'active.json')
  const hostPid = options.hostPid ?? process.pid
  const pidAlive = options.isPidAlive ?? isProcessAlive
  const now = options.now ?? (() => new Date())
  const token = options.token ?? randomUUID()

  await mkdir(root, { recursive: true })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = now().toISOString()
    const record: RuntimeLeaseRecord = {
      schemaVersion: 1,
      token,
      host: options.host,
      hostPid,
      acquiredAt: timestamp,
      updatedAt: timestamp,
    }

    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      await writeActiveAtomic(activePath, record)

      let current = record
      let released = false
      return {
        root,
        host: options.host,
        token,
        get record() {
          return current
        },
        async updateRuntime(info) {
          if (released) return
          const owner = await readRecord(lockPath)
          if (!owner || owner.token !== token) {
            throw new RuntimeLeaseConflictError(await inspectRuntimeLease(root))
          }
          current = {
            ...current,
            ...(info.runtimePid === undefined ? {} : { runtimePid: info.runtimePid }),
            ...(info.dshVersion === undefined ? {} : { dshVersion: info.dshVersion }),
            updatedAt: now().toISOString(),
          }
          await writeActiveAtomic(activePath, current)
        },
        async release() {
          if (released) return
          released = true
          const owner = await readRecord(lockPath)
          if (!owner || owner.token !== token) return
          await rm(activePath, { force: true }).catch(() => undefined)
          await rm(lockPath, { force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const holder = await inspectRuntimeLease(root)
      if (holder && pidAlive(holder.hostPid)) {
        throw new RuntimeLeaseConflictError(holder)
      }

      // Stale lease from a crashed host. Only remove it after the recorded PID
      // is confirmed dead; the next open('wx') remains the actual race arbiter.
      await rm(activePath, { force: true }).catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  throw new RuntimeLeaseConflictError(await inspectRuntimeLease(root))
}
