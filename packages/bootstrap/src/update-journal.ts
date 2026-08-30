import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type HostUpdateRecoveryPhase = 'staged' | 'installing' | 'verifying' | 'failed'

export interface HostUpdateRecoveryRecord {
  schemaVersion: 1
  component: 'host'
  previousHostVersion: string
  targetHostVersion: string
  phase: HostUpdateRecoveryPhase
  attempt: number
  requestedAt: string
  updatedAt: string
  healthDeadline?: string
  error?: string
}

export function defaultUpdateJournalPath(userDataDir: string): string {
  return path.join(userDataDir, 'updates', 'host-update.json')
}

export async function readHostUpdateRecovery(
  journalPath: string,
): Promise<HostUpdateRecoveryRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
    assertHostUpdateRecovery(value)
    return value
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return null
    throw error
  }
}

export async function stageHostUpdateRecovery(
  journalPath: string,
  input: {
    previousHostVersion: string
    targetHostVersion: string
    now?: Date
  },
): Promise<HostUpdateRecoveryRecord> {
  const now = (input.now ?? new Date()).toISOString()
  const record: HostUpdateRecoveryRecord = {
    schemaVersion: 1,
    component: 'host',
    previousHostVersion: input.previousHostVersion,
    targetHostVersion: input.targetHostVersion,
    phase: 'staged',
    attempt: 0,
    requestedAt: now,
    updatedAt: now,
  }
  await writeJournal(journalPath, record)
  return record
}

export async function markHostUpdateInstalling(
  journalPath: string,
  now: Date = new Date(),
): Promise<HostUpdateRecoveryRecord | null> {
  const record = await readHostUpdateRecovery(journalPath)
  if (!record) return null
  const next: HostUpdateRecoveryRecord = {
    ...record,
    phase: 'installing',
    updatedAt: now.toISOString(),
    error: undefined,
  }
  await writeJournal(journalPath, next)
  return next
}

/**
 * Called by the newly launched Host before booting dsh. If the installer never
 * switched versions, the record remains staged/installing and is not falsely
 * treated as a failed new version.
 */
export async function markHostUpdateVerifying(
  journalPath: string,
  currentHostVersion: string,
  input: { now?: Date; healthTimeoutMs?: number } = {},
): Promise<HostUpdateRecoveryRecord | null> {
  const record = await readHostUpdateRecovery(journalPath)
  if (!record || record.targetHostVersion !== currentHostVersion) return record
  const now = input.now ?? new Date()
  const healthTimeoutMs = input.healthTimeoutMs ?? 180_000
  const next: HostUpdateRecoveryRecord = {
    ...record,
    phase: 'verifying',
    attempt: record.attempt + 1,
    updatedAt: now.toISOString(),
    healthDeadline: new Date(now.getTime() + healthTimeoutMs).toISOString(),
    error: undefined,
  }
  await writeJournal(journalPath, next)
  return next
}

/**
 * Commit the Host update only after HarnessDock completed its real boot health
 * gate (Runtime Lease + dsh ready + official Harness UI window creation).
 */
export async function commitHostUpdateHealth(
  journalPath: string,
  currentHostVersion: string,
): Promise<boolean> {
  const record = await readHostUpdateRecovery(journalPath)
  if (!record || record.targetHostVersion !== currentHostVersion || record.phase !== 'verifying') {
    return false
  }
  await rm(journalPath, { force: true })
  return true
}

export async function recordHostUpdateFailure(
  journalPath: string,
  currentHostVersion: string,
  error: unknown,
  now: Date = new Date(),
): Promise<HostUpdateRecoveryRecord | null> {
  const record = await readHostUpdateRecovery(journalPath)
  if (!record || record.targetHostVersion !== currentHostVersion) return record
  const next: HostUpdateRecoveryRecord = {
    ...record,
    phase: 'failed',
    updatedAt: now.toISOString(),
    error: sanitizeError(error),
  }
  await writeJournal(journalPath, next)
  return next
}

export async function clearHostUpdateRecovery(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true })
}

function assertHostUpdateRecovery(value: unknown): asserts value is HostUpdateRecoveryRecord {
  if (!value || typeof value !== 'object') throw new Error('host update journal must be an object')
  const record = value as Partial<HostUpdateRecoveryRecord>
  if (record.schemaVersion !== 1 || record.component !== 'host') {
    throw new Error('unsupported host update journal schema')
  }
  if (!record.previousHostVersion || !record.targetHostVersion || !record.requestedAt || !record.updatedAt) {
    throw new Error('host update journal is missing required fields')
  }
  if (!['staged', 'installing', 'verifying', 'failed'].includes(String(record.phase))) {
    throw new Error(`invalid host update journal phase: ${String(record.phase)}`)
  }
  if (!Number.isInteger(record.attempt) || (record.attempt ?? -1) < 0) {
    throw new Error('host update journal attempt must be a non-negative integer')
  }
}

async function writeJournal(journalPath: string, record: HostUpdateRecoveryRecord): Promise<void> {
  await mkdir(path.dirname(journalPath), { recursive: true })
  const tempPath = `${journalPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  // Windows rename cannot replace an existing file. Remove only the tiny
  // metadata destination immediately before rename; the previous Host/Runtime
  // itself is never touched by this journal operation.
  await rm(journalPath, { force: true })
  await rename(tempPath, journalPath)
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\r\n]+/g, ' ').slice(0, 2_000)
}
