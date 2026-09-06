import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isHostOwnedPluginId, type PluginRecoveryReason } from './plugin-recovery.ts'

const DEFAULT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000

export interface PluginQuarantineRecord {
  schemaVersion: 2
  dshVersion: string
  dshBaseVersion: string
  createdAt: string
  expiresAt: string
  isolatedPlugins: string[]
  suspectedPlugins: string[]
  reason: PluginRecoveryReason
}

interface ParsedRecord {
  schemaVersion: 1 | 2
  dshVersion: string
  dshBaseVersion?: string
  createdAt: string
  expiresAt: string
  isolatedPlugins: string[]
  suspectedPlugins: string[]
  reason: PluginRecoveryReason
}

function baseVersion(value: string): string {
  return (value.split(/[-+]/, 1)[0] ?? value).trim()
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function parseRecord(raw: string): ParsedRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ParsedRecord>
    const isolatedPlugins = stringList(value.isolatedPlugins)
    const suspectedPlugins = stringList(value.suspectedPlugins)
    if (
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      typeof value.dshVersion !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      (value.reason !== 'diagnostic-match' && value.reason !== 'ambiguous') ||
      !isolatedPlugins ||
      !suspectedPlugins ||
      isolatedPlugins.length === 0 ||
      isolatedPlugins.some(isHostOwnedPluginId) ||
      (value.schemaVersion === 2 && typeof value.dshBaseVersion !== 'string')
    ) {
      return null
    }
    return {
      schemaVersion: value.schemaVersion,
      dshVersion: value.dshVersion,
      ...(value.schemaVersion === 2 ? { dshBaseVersion: value.dshBaseVersion } : {}),
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
 * Read host-owned plugin quarantine. Schema v1 remains exact-version for
 * backwards compatibility. Schema v2 follows the Rust Host and survives only
 * prerelease/build changes inside the same MAJOR.MINOR.PATCH base version.
 * Persisted state is treated as untrusted and can never isolate host plugins.
 */
export async function readPluginQuarantine(
  file: string,
  dshVersion: string,
  now: Date = new Date(),
): Promise<PluginQuarantineRecord | null> {
  let record: ParsedRecord | null = null
  try {
    record = parseRecord(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rm(file, { force: true }).catch(() => undefined)
    }
    return null
  }

  const expiresAt = record ? Date.parse(record.expiresAt) : Number.NaN
  const applies = record?.schemaVersion === 1
    ? record.dshVersion === dshVersion
    : record?.dshBaseVersion === baseVersion(dshVersion)
  if (!record || !applies || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    await rm(file, { force: true }).catch(() => undefined)
    return null
  }
  return {
    schemaVersion: 2,
    dshVersion: record.dshVersion,
    dshBaseVersion: record.schemaVersion === 2
      ? record.dshBaseVersion ?? baseVersion(record.dshVersion)
      : baseVersion(record.dshVersion),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    isolatedPlugins: record.isolatedPlugins,
    suspectedPlugins: record.suspectedPlugins,
    reason: record.reason,
  }
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
  const protectedId = isolatedPlugins.find(isHostOwnedPluginId)
  if (protectedId) {
    throw new Error(`plugin quarantine cannot isolate HarnessDock host-owned plugin: ${protectedId}`)
  }
  const suspectedPlugins = [...new Set((input.suspectedPlugins ?? []).map((id) => id.trim()).filter(Boolean))]
  const record: PluginQuarantineRecord = {
    schemaVersion: 2,
    dshVersion: input.dshVersion,
    dshBaseVersion: baseVersion(input.dshVersion),
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
