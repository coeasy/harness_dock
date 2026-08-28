import { app } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Runtime version override (E2).
 *
 * The desktop client normally runs the dsh version pinned in the packaged
 * origin.json. A user can switch to a different version via the tray →
 * "版本管理…" panel; the choice is persisted in
 * `userData/origin-override.json` (higher priority than the packaged origin)
 * and fed into `bootstrapRuntime({ versionOverride })` on the next boot.
 *
 * Overrides are constrained to versions that already exist locally — the
 * pinned version, the bundled seed version, or a cached `runtime-*` version —
 * so a stray/wrong override can never make the client drift to an arbitrary
 * version. An invalid override is simply ignored at boot.
 *
 * `userDataDir` is injectable so the pure persistence helpers are unit-testable
 * without an Electron runtime; callers omit it to use `app.getPath('userData')`.
 */

/** The runtime download cache lives under userData/runtime-cache (bootstrap default). */
export function runtimeCacheDir(userDataDir: string): string {
  return path.join(userDataDir, 'runtime-cache')
}

export function overridePathFor(userDataDir: string): string {
  return path.join(userDataDir, 'origin-override.json')
}

function defaultUserDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    // Electron not ready / unit test environment
    return os.tmpdir()
  }
}

export function overridePath(): string {
  return overridePathFor(defaultUserDataDir())
}

export async function readVersionOverride(userDataDir?: string): Promise<string | null> {
  try {
    const raw = await readFile(overridePathFor(userDataDir ?? defaultUserDataDir()), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
  } catch {
    // missing or malformed override -> none
  }
  return null
}

export async function writeVersionOverride(version: string, userDataDir?: string): Promise<void> {
  const target = overridePathFor(userDataDir ?? defaultUserDataDir())
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify({ version }, null, 2)}\n`, 'utf8')
}

export async function clearVersionOverride(userDataDir?: string): Promise<void> {
  await rm(overridePathFor(userDataDir ?? defaultUserDataDir()), { force: true })
}

/** List dsh versions present as `runtime-<version>` dirs in the cache dir. */
export async function listCachedRuntimeVersions(cacheDir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch {
    return []
  }
  const versions: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('runtime-')) continue
    const version = entry.name.slice('runtime-'.length)
    if (version.length === 0) continue
    versions.push(version)
  }
  return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/**
 * A target version is allowed only when it is the pinned version, the bundled
 * seed version, or one of the cached `runtime-*` versions. This deliberately
 * blocks switching to any arbitrary version the user might type.
 */
export function isAllowedVersion(
  version: string,
  input: { pinned?: string; seed?: string | null; cached: string[] },
): boolean {
  const allow = new Set<string>()
  if (input.pinned) allow.add(input.pinned)
  if (input.seed) allow.add(input.seed)
  for (const v of input.cached) allow.add(v)
  return allow.has(version)
}
