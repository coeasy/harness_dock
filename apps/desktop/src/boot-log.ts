import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, shell } from 'electron'
import { redactDiagnostics, type ClientLogEvent, type ClientLogRecord } from '@dsh/bootstrap/client-core'
import { redactLogText } from './log-redaction.ts'

let logDirCache: string | undefined

/**
 * Log directory, resolved lazily on first use so `app.getPath('userData')` is
 * available (after app ready). Falls back to the OS temp dir when the app is
 * not ready yet or the path cannot be resolved; the fallback is not cached so
 * a later call after app ready can still resolve the real directory.
 */
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

/** Current human boot log file (boot-YYYY-MM-DD.log). */
export function getLogFile(): string {
  return path.join(getLogDir(), `boot-${new Date().toISOString().slice(0, 10)}.log`)
}

/** Current structured event file (events-YYYY-MM-DD.jsonl). */
export function getStructuredLogFile(): string {
  return path.join(getLogDir(), `events-${new Date().toISOString().slice(0, 10)}.jsonl`)
}

function safeEvent(input: ClientLogEvent): ClientLogRecord {
  return {
    timestamp: new Date().toISOString(),
    level: input.level,
    component: input.component.slice(0, 80),
    event: input.event.slice(0, 120),
    ...(input.message ? { message: redactLogText(input.message).slice(0, 4000) } : {}),
    ...(input.data ? { data: redactDiagnostics(input.data) } : {}),
  }
}

/** Best-effort structured event log. Secret-bearing keys and text are redacted. */
export async function bootLogEvent(event: ClientLogEvent): Promise<void> {
  try {
    await mkdir(getLogDir(), { recursive: true })
    await appendFile(getStructuredLogFile(), `${JSON.stringify(safeEvent(event))}\n`, 'utf8')
  } catch {
    // best-effort; never mask the original failure
  }
}

/** Best-effort timestamped human log plus structured compatibility event. */
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

/** Read the newest structured events from today's JSONL file. */
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

/** Delete HarnessDock daily log files older than `days`. */
export async function pruneOldLogs(days = 7): Promise<void> {
  const dir = getLogDir()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      const managed =
        (name.startsWith('boot-') && name.endsWith('.log')) ||
        (name.startsWith('events-') && name.endsWith('.jsonl'))
      if (!managed) continue
      const full = path.join(dir, name)
      const info = await stat(full)
      if (info.mtimeMs < cutoff) await rm(full, { force: true })
    }
  } catch {
    // best-effort; directory may not exist yet
  }
}

/** Open the log directory in the system file manager; failures are ignored. */
export async function openLogDir(): Promise<void> {
  try {
    await shell.openPath(getLogDir())
  } catch {
    // ignore failures
  }
}
