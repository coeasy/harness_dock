import { app, Notification } from 'electron'
import { bundledRuntimeVersion } from '@dsh/client-runtime'
import { bootstrapRuntime } from '@dsh/bootstrap'
import { readOriginFile } from '@dsh/docs-sync'
import { bootLog, openLogDir } from '../boot-log.ts'
import { fmt, t } from '../i18n.ts'
import { appState } from '../state.ts'
import {
  createSplash,
  formatMb,
  showFirstLaunchHints,
  showSplashDone,
  showSplashProgress,
  updateSplash,
} from '../splash.ts'
import { createWindow, toggleMainWindow } from '../window/main-window.ts'
import { createTray } from '../tray.ts'
import { initAutoUpdate, type AutoUpdateHandle } from '../auto-update.ts'
import { openDiagnosticsWindow } from '../diagnostics/diagnostics.ts'
import { bundledRoot, originPath, pluginPath } from '../paths.ts'
import {
  isAllowedVersion,
  listCachedRuntimeVersions,
  readVersionOverride,
  runtimeCacheDir,
} from '../version-override.ts'

let autoUpdate: AutoUpdateHandle | undefined

/**
 * Boot orchestration: splash → shared bootstrap (origin → runtime → start,
 * with last-known-good rollback) → main window → auto-update → tray.
 *
 * All concrete work lives in `@dsh/bootstrap` (shared with the VS Code host);
 * this module only wires it to the desktop UX.
 */
export async function bootFlow(): Promise<void> {
  await createSplash()
  updateSplash(t('splash.loading'))
  showSplashProgress(null) // virtual loading while nothing measurable yet

  const userDataDir = app.getPath('userData')
  const versionOverride = await resolveVersionOverride(userDataDir)

  const result = await bootstrapRuntime({
    originPath: originPath(),
    pluginPath: pluginPath(),
    packaged: app.isPackaged,
    bundledRoot: bundledRoot(),
    userDataDir,
    versionOverride,
    stopTimeoutMs: 12_000,
    log: (message) => void bootLog(message),
    onBeforeStart: ({ bundledAvailable }) => {
      void bootLog(
        `runtime mode: ${bundledAvailable ? 'bundled (offline)' : 'download (first launch fetches ~300MB over HTTPS)'}`,
      )
      if (bundledAvailable) {
        updateSplash(t('splash.startingRuntime'))
      } else {
        updateSplash(t('splash.firstLaunch'))
        showFirstLaunchHints()
      }
    },
    onProgress: (event) => {
      if (event.stage === 'fetch') {
        showSplashProgress(event.percent ?? null)
        const pct = `${event.percent ?? 0}%`
        const bytes = event.bytes ? formatMb(event.bytes) : '—'
        updateSplash(
          fmt(t('splash.downloading'), {
            pct,
            done: event.done,
            total: event.total,
            bytes,
            name: event.name,
          }),
        )
      } else if (event.stage === 'resolve') {
        // No measurable total during the metadata phase: keep the bar moving.
        showSplashProgress(null)
        updateSplash(
          event.total
            ? fmt(t('splash.resolving'), { total: event.total, done: event.done ?? 0 })
            : fmt(t('splash.resolvingUnknown'), { done: event.done ?? 0 }),
        )
      } else if (event.stage === 'done') {
        showSplashDone()
        updateSplash(t('splash.ready'))
      }
    },
    onRollback: (info) => {
      void bootLog(`boot: rolled back to last-known-good dsh ${info.to}`)
      try {
        new Notification({
          title: t('common.appTitle'),
          body: fmt(t('rollback.notification'), { from: info.from, to: info.to }),
        }).show()
      } catch {
        // notifications unavailable
      }
    },
  })

  appState.runtime = result.runtime
  appState.dshPid = result.ready.pid
  appState.dshVersion = result.ready.dshVersion
  appState.mode = result.mode
  appState.bundledAvailable = result.bundledAvailable
  await bootLog(`dsh web ready at ${result.ready.url} (pid ${result.ready.pid})`)
  updateSplash(t('splash.loadingInterface'))
  await createWindow(result.ready.url)

  try {
    autoUpdate = initAutoUpdate()
  } catch (error) {
    await bootLog(`auto-update init failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    appState.tray = createTray({
      onToggle: toggleMainWindow,
      onOpenLog: () => void openLogDir(),
      onDiagnostics: () => openDiagnosticsWindow('info'),
      onVersions: () => openDiagnosticsWindow('versions'),
      onQuit: () => app.quit(),
      onCheckUpdate: () => autoUpdate?.checkNow(),
    })
  } catch (error) {
    await bootLog(`tray creation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read userData/origin-override.json before booting. Returns the override when
 * it is non-empty and allowed (pinned / seed / cached); logs and ignores
 * anything else so a stray override can never drift the client to an arbitrary
 * version.
 */
async function resolveVersionOverride(userDataDir: string): Promise<string | undefined> {
  const override = await readVersionOverride(userDataDir)
  if (!override) return undefined
  let pinned = ''
  try {
    pinned = (await readOriginFile(originPath())).dshVersion
  } catch {
    // origin missing (unpackaged dev run)
  }
  const seed = bundledRuntimeVersion(bundledRoot())
  const cached = await listCachedRuntimeVersions(runtimeCacheDir(userDataDir))
  if (isAllowedVersion(override, { pinned, seed, cached })) {
    await bootLog(`version override: switching to dsh ${override} (pinned=${pinned || '?'}, seed=${seed ?? 'none'})`)
    return override
  }
  await bootLog(
    `version override: ignoring ${override} (not pinned/seed/cached); using pinned ${pinned || '?'}`,
  )
  return undefined
}
