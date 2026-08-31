import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginRecoveryReason } from './plugin-recovery.ts'

const DEFAULT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000

export interface PluginQuarantineRecord {
  schemaVersion: 1
  dshVersion: string
  createdAt: string
  expiresAt: string
  isolatedPlugins: string[]
  suspectedPlugins: string[]
  reason: PluginRecoveryReason
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function parseRecord(raw: string): PluginQuarantineRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PluginQuarantineRecord>
    const isolatedPlugins = stringList(value.isolatedPlugins)
    const suspectedPlugins = stringList(value.suspectedPlugins)
    if (
      value.schemaVersion !== 1 ||
      typeof value.dshVersion !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      (value.reason !== 'diagnostic-match' && value.reason !== 'ambiguous') ||
      !isolatedPlugins ||
      !suspectedPlugins ||
      isolatedPlugins.length === 0
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      dshVersion: value.dshVersion,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      isolatedPlugins,
      suspectedPlugins,
      reason: value.reason,
    }
  } catch {
    return null
  }
}

async function writeAtomic(file: string, record: PluginQuarantineRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

/**
 * Read a host-owned plugin quarantine record. Records are scoped to the exact
 * dsh version and automatically expire, so upgrading dsh/plugins gets a fresh
 * normal boot instead of permanently disabling anything in the user's config.
 */
export async function readPluginQuarantine(
  file: string,
  dshVersion: string,
  now: Date = new Date(),
): Promise<PluginQuarantineRecord | null> {
  let record: PluginQuarantineRecord | null = null
  try {
    record = parseRecord(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rm(file, { force: true }).catch(() => undefined)
    }
    return null
  }

  const expiresAt = record ? Date.parse(record.expiresAt) : Number.NaN
  if (
    !record ||
    record.dshVersion !== dshVersion ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime()
  ) {
    await rm(file, { force: true }).catch(() => undefined)
    return null
  }
  return record
}

export async function writePluginQuarantine(
  file: string,
  input: {
    dshVersion: string
    isolatedPlugins: readonly string[]
    suspectedPlugins?: readonly string[]
    reason: PluginRecoveryReason
    now?: Date
    ttlMs?: number
  },
): Promise<PluginQuarantineRecord> {
  const now = input.now ?? new Date()
  const ttlMs = Math.max(60_000, input.ttlMs ?? DEFAULT_QUARANTINE_TTL_MS)
  const isolatedPlugins = [...new Set(input.isolatedPlugins.map((id) => id.trim()).filter(Boolean))]
  if (isolatedPlugins.length === 0) throw new Error('plugin quarantine requires at least one plugin id')
  const suspectedPlugins = [...new Set((input.suspectedPlugins ?? []).map((id) => id.trim()).filter(Boolean))]
  const record: PluginQuarantineRecord = {
    schemaVersion: 1,
    dshVersion: input.dshVersion,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    isolatedPlugins,
    suspectedPlugins,
    reason: input.reason,
  }
  await writeAtomic(file, record)
  return record
}

export async function clearPluginQuarantine(file: string): Promise<void> {
  await rm(file, { force: true })
}

export { DEFAULT_QUARANTINE_TTL_MS }
