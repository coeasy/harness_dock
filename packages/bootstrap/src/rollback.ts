import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * last-known-good origin backup (shared by desktop and VS Code hosts).
 *
 * Keeps the origin that actually booted successfully so a failing future dsh
 * version can fall back without bricking. `effectiveOrigin` matters when a Host
 * runs a cached/managed version through versionOverride: copying the packaged
 * origin file would incorrectly record the older packaged pin instead of the
 * Runtime that just proved healthy.
 */

export function defaultPreviousOriginPath(userDataDir: string): string {
  return path.join(userDataDir, 'previous-origin.json')
}

/**
 * Back up the effective current origin whenever the successful dsh version
 * changes. When effectiveOrigin is omitted the packaged origin file is read,
 * preserving the original API for callers that do not use an override.
 */
export async function backupOrigin(
  originPath: string,
  previousOriginPath: string,
  log?: (message: string) => void,
  effectiveOrigin?: Record<string, unknown>,
): Promise<void> {
  try {
    const current = effectiveOrigin ?? (JSON.parse(await readFile(originPath, 'utf8')) as Record<string, unknown>)
    const currentVersion = typeof current.dshVersion === 'string' ? current.dshVersion : undefined
    if (!currentVersion) throw new Error('effective origin is missing dshVersion')

    let previous: { dshVersion?: string } | null = null
    try {
      previous = JSON.parse(await readFile(previousOriginPath, 'utf8')) as { dshVersion?: string }
    } catch {
      // no previous backup yet
    }
    if (previous?.dshVersion === currentVersion) return

    await mkdir(path.dirname(previousOriginPath), { recursive: true })
    await writeFile(previousOriginPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    log?.(`origin backup: ${previous?.dshVersion ?? '(none)'} -> ${currentVersion}`)
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
