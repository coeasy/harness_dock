import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, shell } from 'electron'

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

/** Current boot log file (boot-YYYY-MM-DD.log inside getLogDir()). */
export function getLogFile(): string {
  return path.join(getLogDir(), `boot-${new Date().toISOString().slice(0, 10)}.log`)
}

/** Best-effort timestamped log; never masks the original failure. */
export async function bootLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    await mkdir(getLogDir(), { recursive: true })
    await appendFile(getLogFile(), line, 'utf8')
  } catch {
    // best-effort; never mask the original failure
  }
}

/** Delete boot-*.log files older than `days` in the log directory. */
export async function pruneOldLogs(days = 7): Promise<void> {
  const dir = getLogDir()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      if (!name.startsWith('boot-') || !name.endsWith('.log')) continue
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
