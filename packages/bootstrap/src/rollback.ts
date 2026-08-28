import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * last-known-good origin backup (shared by desktop and VS Code hosts).
 *
 * Keeps a copy of the previously pinned origin so that if a freshly released
 * dsh version fails to boot, the host can fall back to the previous pinned
 * version instead of bricking. Backing up happens before starting the runtime;
 * the rollback is attempted only when the new version actually fails to start.
 */

export function defaultPreviousOriginPath(userDataDir: string): string {
  return path.join(userDataDir, 'previous-origin.json')
}

/**
 * Back up the current origin to previous-origin.json whenever the pinned dsh
 * version changes. No-op when the version is unchanged or the backup path is
 * not configured.
 */
export async function backupOrigin(
  originPath: string,
  previousOriginPath: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    const current = JSON.parse(await readFile(originPath, 'utf8')) as { dshVersion?: string }
    let previous: { dshVersion?: string } | null = null
    try {
      previous = JSON.parse(await readFile(previousOriginPath, 'utf8')) as { dshVersion?: string }
    } catch {
      // no previous backup yet
    }
    if (previous?.dshVersion === current.dshVersion) return
    await copyFile(originPath, previousOriginPath)
    log?.(`origin backup: ${previous?.dshVersion ?? '(none)'} -> ${current.dshVersion}`)
  } catch (error) {
    log?.(`origin backup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Returns the previous origin when it exists and pins a different dsh version
 * than the current one; null otherwise (first run / unchanged).
 */
export async function readPreviousOrigin(
  previousOriginPath: string,
  currentDshVersion: string,
): Promise<{ origin: Record<string, unknown>; dshVersion: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(previousOriginPath, 'utf8')) as {
      dshVersion?: string
      [key: string]: unknown
    }
    if (!parsed.dshVersion || parsed.dshVersion === currentDshVersion) return null
    return { origin: parsed, dshVersion: parsed.dshVersion }
  } catch {
    return null
  }
}
