import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, shell } from 'electron'
import { redactDiagnostics, type ClientLogEvent, type ClientLogRecord } from '@dsh/bootstrap/client-core'
import { redactLogText } from './log-redaction.ts'

let logDirCache: string | undefined
const MAX_EVENT_DATA_CHARS = 32_000
const DEFAULT_LOG_TOTAL_LIMIT = 32 * 1024 * 1024

export function getLogDir(): string {
  if (logDirCache) return logDirCache
  if (!app.isReady()) return path.join(os.tmpdir(), 'harnessdock-logs')
  try {
    logDirCache = path.join(app.getPath('userData'), 'logs')
  } catch {
    return path.join(os.tmpdir(), 'harnessdock-logs')
  }
  return logDirCache
}

export function getLogFile(): string {
  return path.join(getLogDir(), `boot-${new Date().toISOString().slice(0, 10)}.log`)
}

export function getStructuredLogFile(): string {
  return path.join(getLogDir(), `events-${new Date().toISOString().slice(0, 10)}.jsonl`)
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactDiagnostics(data)
  const encoded = JSON.stringify(redacted)
  if (encoded.length <= MAX_EVENT_DATA_CHARS) return redacted
  return {
    truncated: true,
    originalCharacters: encoded.length,
    preview: encoded.slice(0, MAX_EVENT_DATA_CHARS),
  }
}

function safeEvent(input: ClientLogEvent): ClientLogRecord {
  return {
    timestamp: new Date().toISOString(),
    level: input.level,
    component: input.component.slice(0, 80),
    event: input.event.slice(0, 120),
    ...(input.message ? { message: redactLogText(input.message).slice(0, 4000) } : {}),
    ...(input.data ? { data: boundedData(input.data) } : {}),
  }
}

export async function bootLogEvent(event: ClientLogEvent): Promise<void> {
  try {
    await mkdir(getLogDir(), { recursive: true })
    await appendFile(getStructuredLogFile(), `${JSON.stringify(safeEvent(event))}\n`, 'utf8')
  } catch {
    // best-effort; never mask the original failure
  }
}

export async function bootLog(message: string): Promise<void> {
  const safeMessage = redactLogText(message)
  const line = `[${new Date().toISOString()}] ${safeMessage}\n`
  try {
    await mkdir(getLogDir(), { recursive: true })
    await appendFile(getLogFile(), line, 'utf8')
  } catch {
    // best-effort; never mask the original failure
  }
  await bootLogEvent({
    level: 'info',
    component: 'legacy',
    event: 'message',
    message: safeMessage,
  })
}

export async function recentLogEvents(limit = 100): Promise<readonly ClientLogRecord[]> {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
  try {
    const content = await readFile(getStructuredLogFile(), 'utf8')
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-bounded)
    const records: ClientLogRecord[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ClientLogRecord
        if (
          typeof parsed?.timestamp === 'string' &&
          typeof parsed?.level === 'string' &&
          typeof parsed?.component === 'string' &&
          typeof parsed?.event === 'string'
        ) {
          records.push(parsed)
        }
      } catch {
        // one truncated/corrupt line must not make diagnostics unavailable
      }
    }
    return records
  } catch {
    return []
  }
}

function managedLogName(name: string): boolean {
  return (
    (name.startsWith('boot-') && name.endsWith('.log')) ||
    (name.startsWith('events-') && name.endsWith('.jsonl'))
  )
}

/** Enforce both retention days and a hard aggregate log-size ceiling. */
export async function pruneOldLogs(days = 7, maxTotalBytes = DEFAULT_LOG_TOTAL_LIMIT): Promise<void> {
  const dir = getLogDir()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  try {
    const entries = (await readdir(dir)).filter(managedLogName)
    for (const name of entries) {
      const full = path.join(dir, name)
      const info = await stat(full)
      if (info.mtimeMs < cutoff) await rm(full, { force: true })
    }

    const survivors = await Promise.all(
      (await readdir(dir)).filter(managedLogName).map(async (name) => {
        const full = path.join(dir, name)
        const info = await stat(full)
        return { full, size: info.size, mtimeMs: info.mtimeMs }
      }),
    )
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = survivors.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of survivors) {
      if (total <= maxTotalBytes) break
      await rm(entry.full, { force: true })
      total -= entry.size
    }
  } catch {
    // best-effort; directory may not exist yet
  }
}

export async function openLogDir(): Promise<void> {
  try {
    await shell.openPath(getLogDir())
  } catch {
    // ignore failures
  }
}
