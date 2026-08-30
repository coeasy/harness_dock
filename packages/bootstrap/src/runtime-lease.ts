import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type HarnessHostId } from './host-capabilities.ts'
import { defaultSharedStateDir } from './host.ts'

export type RuntimeLeaseHostInput = HarnessHostId | 'perry'

export interface RuntimeLeaseRecord {
  schemaVersion: 2
  token: string
  /** Canonical v0.2 owner identity. */
  ownerHost: HarnessHostId
  ownerPid: number
  /** @deprecated v0.1/v0.2 transition alias; use ownerHost. */
  host: HarnessHostId
  /** @deprecated v0.1/v0.2 transition alias; use ownerPid. */
  hostPid: number
  runtimePid?: number
  runtimeId?: string
  endpoint?: string
  dshVersion?: string
  protocolVersion: number
  acquiredAt: string
  updatedAt: string
}

export interface AcquireRuntimeLeaseOptions {
  host: RuntimeLeaseHostInput
  hostPid?: number
  leaseRoot?: string
  isPidAlive?: (pid: number) => boolean
  now?: () => Date
  token?: string
  protocolVersion?: number
}

export interface RuntimeLeaseHandle {
  readonly root: string
  readonly host: HarnessHostId
  readonly ownerHost: HarnessHostId
  readonly ownerPid: number
  readonly token: string
  readonly record: RuntimeLeaseRecord
  updateRuntime(info: {
    runtimePid?: number
    runtimeId?: string
    endpoint?: string
    dshVersion?: string
    protocolVersion?: number
  }): Promise<void>
  heartbeat(info?: { endpoint?: string; protocolVersion?: number }): Promise<void>
  release(): Promise<void>
}

export class RuntimeLeaseConflictError extends Error {
  readonly holder: RuntimeLeaseRecord | null

  constructor(holder: RuntimeLeaseRecord | null) {
    const detail = holder
      ? `${holder.ownerHost} host pid=${holder.ownerPid}${holder.dshVersion ? ` dsh=${holder.dshVersion}` : ''}`
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

function isHarnessHostId(value: unknown): value is HarnessHostId {
  return (
    value === 'electron' ||
    value === 'tauri' ||
    value === 'perry-desktop' ||
    value === 'perry-ios' ||
    value === 'perry-android' ||
    value === 'vscode'
  )
}

export function normalizeRuntimeLeaseHost(host: RuntimeLeaseHostInput): HarnessHostId {
  return host === 'perry' ? 'perry-desktop' : host
}

function positiveProtocolVersion(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 1
}

function normalizeRecord(parsed: unknown): RuntimeLeaseRecord | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record.token !== 'string') return null

  let ownerHost: HarnessHostId
  let ownerPid: number
  if (record.schemaVersion === 2) {
    const candidateHost = isHarnessHostId(record.ownerHost)
      ? record.ownerHost
      : isHarnessHostId(record.host)
        ? record.host
        : null
    const candidatePid = Number.isInteger(record.ownerPid)
      ? (record.ownerPid as number)
      : Number.isInteger(record.hostPid)
        ? (record.hostPid as number)
        : null
    if (!candidateHost || candidatePid === null) return null
    ownerHost = candidateHost
    ownerPid = candidatePid
  } else if (record.schemaVersion === 1 && (record.host === 'electron' || record.host === 'perry')) {
    ownerHost = record.host === 'perry' ? 'perry-desktop' : 'electron'
    if (!Number.isInteger(record.hostPid)) return null
    ownerPid = record.hostPid as number
  } else {
    return null
  }

  if (typeof record.acquiredAt !== 'string' || typeof record.updatedAt !== 'string') return null

  return {
    schemaVersion: 2,
    token: record.token,
    ownerHost,
    ownerPid,
    host: ownerHost,
    hostPid: ownerPid,
    ...(Number.isInteger(record.runtimePid) ? { runtimePid: record.runtimePid as number } : {}),
    ...(typeof record.runtimeId === 'string' ? { runtimeId: record.runtimeId } : {}),
    ...(typeof record.endpoint === 'string' ? { endpoint: record.endpoint } : {}),
    ...(typeof record.dshVersion === 'string' ? { dshVersion: record.dshVersion } : {}),
    protocolVersion: positiveProtocolVersion(record.protocolVersion),
    acquiredAt: record.acquiredAt,
    updatedAt: record.updatedAt,
  }
}

async function readRecord(file: string): Promise<RuntimeLeaseRecord | null> {
  try {
    return normalizeRecord(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

async function writeActiveAtomic(file: string, record: RuntimeLeaseRecord): Promise<void> {
  const tmp = `${file}.${record.token}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * runtime.lock is the ownership source of truth. active.json is richer status
 * for diagnostics, but is only trusted when its token matches the lock owner.
 * Version-1 Electron/Perry and early version-2 records are normalized on read
 * so v0.2 upgrades can safely recover or report locks left by older clients.
 */
export async function inspectRuntimeLease(
  leaseRoot = defaultRuntimeLeaseRoot(),
): Promise<RuntimeLeaseRecord | null> {
  const lock = await readRecord(path.join(leaseRoot, 'runtime.lock'))
  const active = await readRecord(path.join(leaseRoot, 'active.json'))
  if (!lock) return active
  if (active?.token === lock.token) return active
  return lock
}

export async function acquireRuntimeLease(
  options: AcquireRuntimeLeaseOptions,
): Promise<RuntimeLeaseHandle> {
  const root = path.resolve(options.leaseRoot ?? defaultRuntimeLeaseRoot())
  const lockPath = path.join(root, 'runtime.lock')
  const activePath = path.join(root, 'active.json')
  const ownerHost = normalizeRuntimeLeaseHost(options.host)
  const ownerPid = options.hostPid ?? process.pid
  const pidAlive = options.isPidAlive ?? isProcessAlive
  const now = options.now ?? (() => new Date())
  const token = options.token ?? randomUUID()
  const initialProtocolVersion = positiveProtocolVersion(options.protocolVersion)

  await mkdir(root, { recursive: true })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = now().toISOString()
    const record: RuntimeLeaseRecord = {
      schemaVersion: 2,
      token,
      ownerHost,
      ownerPid,
      host: ownerHost,
      hostPid: ownerPid,
      protocolVersion: initialProtocolVersion,
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

      const assertOwnership = async (): Promise<void> => {
        const owner = await readRecord(lockPath)
        if (!owner || owner.token !== token) {
          throw new RuntimeLeaseConflictError(await inspectRuntimeLease(root))
        }
      }

      const writeCurrent = async (changes: Partial<RuntimeLeaseRecord>): Promise<void> => {
        current = {
          ...current,
          ...changes,
          ownerHost,
          ownerPid,
          host: ownerHost,
          hostPid: ownerPid,
          updatedAt: now().toISOString(),
        }
        await writeActiveAtomic(activePath, current)
      }

      return {
        root,
        host: ownerHost,
        ownerHost,
        ownerPid,
        token,
        get record() {
          return current
        },
        async updateRuntime(info) {
          if (released) return
          await assertOwnership()
          await writeCurrent({
            ...(info.runtimePid === undefined ? {} : { runtimePid: info.runtimePid }),
            ...(info.runtimeId === undefined ? {} : { runtimeId: info.runtimeId }),
            ...(info.endpoint === undefined ? {} : { endpoint: info.endpoint }),
            ...(info.dshVersion === undefined ? {} : { dshVersion: info.dshVersion }),
            ...(info.protocolVersion === undefined
              ? {}
              : { protocolVersion: positiveProtocolVersion(info.protocolVersion) }),
          })
        },
        async heartbeat(info = {}) {
          if (released) return
          await assertOwnership()
          await writeCurrent({
            ...(info.endpoint === undefined ? {} : { endpoint: info.endpoint }),
            ...(info.protocolVersion === undefined
              ? {}
              : { protocolVersion: positiveProtocolVersion(info.protocolVersion) }),
          })
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
      if (holder && pidAlive(holder.ownerPid)) {
        throw new RuntimeLeaseConflictError(holder)
      }

      await rm(activePath, { force: true }).catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  throw new RuntimeLeaseConflictError(await inspectRuntimeLease(root))
}
