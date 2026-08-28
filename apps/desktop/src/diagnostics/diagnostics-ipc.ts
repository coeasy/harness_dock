import { app, ipcMain } from 'electron'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { bundledRuntimeVersion } from '@dsh/client-runtime'
import { readOriginFile } from '@dsh/docs-sync'
import { getLogFile, openLogDir } from '../boot-log.ts'
import { bundledRoot, originPath } from '../paths.ts'
import { appState } from '../state.ts'
import {
  clearVersionOverride,
  isAllowedVersion,
  listCachedRuntimeVersions,
  readVersionOverride,
  runtimeCacheDir,
  writeVersionOverride,
} from '../version-override.ts'
import {
  cacheSizeBytes,
  computeKeepSet,
  selectOldVersions,
  tailLines,
  type DiagnosticsInfo,
} from './diagnostics.ts'

/**
 * Diagnostics IPC (E1/E2). All channels are `ipcMain.handle` backed by the
 * `dshDiagnostics` preload bridge. Kept in its own module so diagnostics.ts
 * stays focused on the window + HTML + pure helpers.
 */

let registered = false

export function registerDiagnosticsIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle('diagnostics:get-info', () => getInfo())
  ipcMain.handle('diagnostics:list-versions', () => listCachedVersions())
  ipcMain.handle('diagnostics:clean-old', () => cleanOldVersions())
  ipcMain.handle('diagnostics:tail-log', () => tailLog())
  ipcMain.handle('diagnostics:export', () => exportDiagnostics())
  ipcMain.handle('diagnostics:switch-version', (_event, version: unknown) =>
    switchVersion(typeof version === 'string' ? version : ''),
  )
  ipcMain.handle('diagnostics:clear-override', async () => {
    await clearVersionOverride()
    return { ok: true }
  })
  ipcMain.handle('diagnostics:open-log', async () => {
    await openLogDir()
    return { ok: true }
  })
  ipcMain.handle('diagnostics:restart', () => {
    relaunchApp()
    return { ok: true }
  })
}

function relaunchApp(): void {
  try {
    app.relaunch()
  } catch {
    // relaunch unavailable (dev / bare electron); fall through to exit
  }
  app.exit(0)
}

async function getInfo(): Promise<DiagnosticsInfo> {
  let pinned = ''
  try {
    pinned = (await readOriginFile(originPath())).dshVersion
  } catch {
    // origin missing (unpackaged dev run)
  }
  const cacheDir = runtimeCacheDir(app.getPath('userData'))
  const [cachedVersions, override, size] = await Promise.all([
    listCachedRuntimeVersions(cacheDir),
    readVersionOverride(),
    cacheSizeBytes(cacheDir),
  ])
  return {
    dshVersion: appState.dshVersion ?? '',
    pinnedVersion: pinned,
    overrideVersion: override,
    mode: appState.mode ?? 'unknown',
    bundledAvailable: appState.bundledAvailable ?? false,
    cacheDir,
    cacheSizeBytes: size,
    seedVersion: bundledRuntimeVersion(bundledRoot()),
    cachedVersions,
    dshPid: appState.dshPid,
    platform: process.platform,
    electron: process.versions.electron,
    generatedAt: new Date().toISOString(),
  }
}

async function listCachedVersions(): Promise<string[]> {
  return listCachedRuntimeVersions(runtimeCacheDir(app.getPath('userData')))
}

async function cleanOldVersions(): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  try {
    const cacheDir = runtimeCacheDir(app.getPath('userData'))
    const info = await getInfo()
    const keep = computeKeepSet({
      pinned: info.pinnedVersion,
      seed: info.seedVersion,
      current: info.dshVersion,
      override: info.overrideVersion,
    })
    const toDelete = selectOldVersions(info.cachedVersions, keep)
    for (const version of toDelete) {
      await rm(path.join(cacheDir, `runtime-${version}`), { recursive: true, force: true })
    }
    return { ok: true, deleted: toDelete }
  } catch (error) {
    return { ok: false, deleted: [], error: error instanceof Error ? error.message : String(error) }
  }
}

async function tailLog(): Promise<{ ok: boolean; log: string; file: string; error?: string }> {
  const file = getLogFile()
  try {
    const raw = await readFile(file, 'utf8')
    return { ok: true, log: tailLines(raw), file }
  } catch (error) {
    return { ok: false, log: '', file, error: error instanceof Error ? error.message : String(error) }
  }
}

async function switchVersion(
  version: string,
): Promise<{ ok: boolean; reason?: string; error?: string }> {
  try {
    if (!version || version.length === 0) return { ok: false, reason: 'empty' }
    const info = await getInfo()
    if (!isAllowedVersion(version, { pinned: info.pinnedVersion, seed: info.seedVersion, cached: info.cachedVersions })) {
      return { ok: false, reason: 'not-allowed' }
    }
    await writeVersionOverride(version)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function exportDiagnostics(): Promise<{ ok: boolean; zipPath?: string; error?: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-diag-'))
  try {
    const info = await getInfo()
    let originRaw = '{}\n'
    try {
      originRaw = `${JSON.stringify(await readOriginFile(originPath()), null, 2)}\n`
    } catch {
      // origin missing
    }
    await writeFile(path.join(tmp, 'origin.json'), originRaw, 'utf8')
    await copyFile(getLogFile(), path.join(tmp, 'boot.log')).catch(() => undefined)
    await writeFile(path.join(tmp, 'versions-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8')

    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, '')
      .replace('T', '-')
    const zipPath = path.join(app.getPath('userData'), `diagnostics-${stamp}.zip`)
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zipPath}' -Force`,
      ])
    } else {
      await execFileAsync('tar', ['-czf', zipPath, '-C', tmp, '.'])
    }
    await rm(tmp, { recursive: true, force: true })
    return { ok: true, zipPath }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const detail = stderr ? `: ${String(stderr).slice(0, 500)}` : ''
        reject(new Error(`[${file} ${args.join(' ')}] failed${detail}`))
        return
      }
      resolve()
    })
  })
}
