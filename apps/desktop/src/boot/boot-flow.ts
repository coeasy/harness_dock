import { app, Notification } from 'electron'
import { bundledRuntimeVersion, redactWebAuthTokens } from '@dsh/client-runtime'
import {
  acquireRuntimeLease,
  backupOrigin,
  commitManagedRuntimeCandidate,
  compareVersions,
  defaultManagedRuntimeStatePath,
  defaultPreviousOriginPath,
  failManagedRuntimeCandidate,
  LocalRuntimeProvider,
  markManagedRuntimeVerifying,
  readManagedRuntimeState,
  selectManagedRuntimeVersion,
} from '@dsh/bootstrap'
import { startHarnessGateway } from '@dsh/bootstrap/gateway'
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
import { initRuntimeAutoUpdate } from '../runtime-auto-update.ts'
import { openDiagnosticsWindow } from '../diagnostics/diagnostics.ts'
import { openMobileManagerWindow } from '../mobile/mobile-window.ts'
import { bundledRoot, originPath, pluginPath } from '../paths.ts'
import {
  isAllowedVersion,
  listCachedRuntimeVersions,
  readVersionOverride,
  runtimeCacheDir,
} from '../version-override.ts'
import { BootProgressTracker } from './progress.ts'

let autoUpdate: AutoUpdateHandle | undefined

interface BootVersionSelection {
  version?: string
  managedCandidate?: string
  managedStatePath?: string
}

/**
 * Boot orchestration: splash → cross-host runtime lease → LocalRuntimeProvider
 * (origin → runtime → start, with last-known-good rollback) → optional secure
 * remote gateway → main window → Host/Runtime auto-update → tray.
 *
 * Manual Runtime selection always wins. Otherwise a verified managed Runtime
 * candidate can be activated from the versioned cache. It is committed only
 * after dsh + the official Harness UI window pass boot; a failed candidate is
 * quarantined and the shared bootstrap falls back to last-known-good.
 */
export async function bootFlow(): Promise<void> {
  const progress = new BootProgressTracker()
  await createSplash()
  updateSplash(t('splash.loading'))
  showSplashProgress(progress.start())

  const runtimeLease = await acquireRuntimeLease({ host: 'electron' })
  appState.runtimeLease = runtimeLease
  let localProvider: LocalRuntimeProvider | undefined
  let managedCandidate: string | undefined
  let managedStatePath: string | undefined

  try {
    const userDataDir = app.getPath('userData')
    const selection = await resolveBootVersionSelection(userDataDir)
    managedCandidate = selection.managedCandidate
    managedStatePath = selection.managedStatePath

    localProvider = new LocalRuntimeProvider({
      originPath: originPath(),
      pluginPath: pluginPath(),
      packaged: app.isPackaged,
      bundledRoot: bundledRoot(),
      userDataDir,
      versionOverride: selection.version,
      // Managed candidates are not last-known-good merely because `dsh web`
      // reports ready. Defer persistence until the official Harness UI also
      // loads below; this avoids promoting a backend-compatible/UI-broken build.
      deferOriginBackup: Boolean(managedCandidate),
      stopTimeoutMs: 12_000,
      log: (message) => void bootLog(message),
      onBeforeStart: ({ bundledAvailable }) => {
        showSplashProgress(progress.preparingRuntime(bundledAvailable))
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
          showSplashProgress(progress.fetching(event.percent))
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
          showSplashProgress(progress.resolving(event.done ?? 0, event.total))
          updateSplash(
            event.total
              ? fmt(t('splash.resolving'), { total: event.total, done: event.done ?? 0 })
              : fmt(t('splash.resolvingUnknown'), { done: event.done ?? 0 }),
          )
        } else if (event.stage === 'done') {
          showSplashProgress(progress.runtimeInstalled())
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

    const session = await localProvider.connect()
    const result = localProvider.bootstrapResult
    if (!result) throw new Error('LocalRuntimeProvider connected without a bootstrap result.')

    if (managedCandidate && managedStatePath && result.rolledBack) {
      await failManagedRuntimeCandidate(
        managedStatePath,
        managedCandidate,
        new Error(`candidate ${managedCandidate} rolled back to ${result.rolledBack.to}`),
      )
      await bootLog(
        `runtime auto-update: candidate ${managedCandidate} quarantined after rollback to ${result.rolledBack.to}`,
      )
      managedCandidate = undefined
    }

    appState.runtime = result.runtime
    appState.dshPid = result.ready.pid
    appState.dshVersion = result.ready.dshVersion
    appState.mode = result.mode
    appState.bundledAvailable = result.bundledAvailable
    await runtimeLease.updateRuntime({
      runtimePid: result.ready.pid,
      dshVersion: result.ready.dshVersion,
    })
    await bootLog(`dsh web ready at ${redactWebAuthTokens(session.appUrl)} (pid ${result.ready.pid})`)
    showSplashProgress(progress.runtimeReady())
    await startRemoteGatewayIfEnabled(session.appUrl)
    updateSplash(t('splash.loadingInterface'))
    showSplashProgress(progress.loadingInterface())
    await createWindow(session.appUrl)

    // The candidate is not active merely because dsh spawned. Commit only after
    // the official Harness UI window also loaded and the effective origin can
    // be persisted as the new last-known-good rollback target.
    if (managedCandidate && managedStatePath && result.ready.dshVersion === managedCandidate) {
      const backedUp = await backupOrigin(
        originPath(),
        defaultPreviousOriginPath(userDataDir),
        (message) => void bootLog(message),
        result.origin as unknown as Record<string, unknown>,
      )
      if (backedUp) {
        await commitManagedRuntimeCandidate(managedStatePath, managedCandidate)
        await bootLog(`runtime auto-update: candidate ${managedCandidate} passed full health gate and is now active`)
      } else {
        await failManagedRuntimeCandidate(
          managedStatePath,
          managedCandidate,
          new Error('candidate passed UI health but last-known-good state could not be persisted'),
        )
        await bootLog(
          `runtime auto-update: candidate ${managedCandidate} remains uncommitted because LKG persistence failed; next launch will use the previous healthy Runtime`,
        )
      }
      managedCandidate = undefined
    }

    showSplashProgress(progress.complete())
    showSplashDone()

    try {
      autoUpdate = initAutoUpdate()
    } catch (error) {
      await bootLog(`auto-update init failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      initRuntimeAutoUpdate()
    } catch (error) {
      await bootLog(`runtime auto-update init failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      appState.tray = createTray({
        onToggle: toggleMainWindow,
        onOpenLog: () => void openLogDir(),
        onMobileDevices: openMobileManagerWindow,
        onDiagnostics: () => openDiagnosticsWindow('info'),
        onVersions: () => openDiagnosticsWindow('versions'),
        onQuit: () => app.quit(),
        onCheckUpdate: () => autoUpdate?.checkNow(),
      })
    } catch (error) {
      await bootLog(`tray creation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } catch (error) {
    if (managedCandidate && managedStatePath) {
      await failManagedRuntimeCandidate(managedStatePath, managedCandidate, error).catch(() => undefined)
    }
    appState.runtimeLease = undefined
    await appState.gateway?.stop().catch(() => undefined)
    appState.gateway = undefined
    await localProvider?.disconnect().catch(() => undefined)
    appState.runtime = undefined
    appState.dshPid = undefined
    appState.dshVersion = undefined
    appState.mode = undefined
    appState.bundledAvailable = undefined
    await runtimeLease.release().catch(() => undefined)
    throw error
  }
}

async function startRemoteGatewayIfEnabled(upstreamUrl: string): Promise<void> {
  if (process.env.HARNESSDOCK_GATEWAY_ENABLE !== '1') return

  const rawPort = process.env.HARNESSDOCK_GATEWAY_PORT?.trim()
  const port = rawPort ? Number.parseInt(rawPort, 10) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HARNESSDOCK_GATEWAY_PORT: ${rawPort}`)
  }

  const gateway = await startHarnessGateway({
    upstreamUrl,
    bindHost: process.env.HARNESSDOCK_GATEWAY_BIND?.trim() || '127.0.0.1',
    port,
    publicBaseUrl: process.env.HARNESSDOCK_GATEWAY_PUBLIC_URL?.trim() || undefined,
    allowInsecurePublicUrl: process.env.HARNESSDOCK_GATEWAY_ALLOW_INSECURE === '1',
    log: (message) => void bootLog(`gateway: ${message}`),
  })
  appState.gateway = gateway
  await bootLog(`remote gateway ready: local=${gateway.localUrl} public=${gateway.publicUrl}`)

  if (process.env.HARNESSDOCK_GATEWAY_PAIR_ON_START === '1') {
    const ticket = gateway.createPairingTicket()
    try {
      new Notification({
        title: 'HarnessDock Mobile Pairing',
        body: `Pairing code: ${ticket.code} (expires ${new Date(ticket.expiresAt).toLocaleTimeString()})`,
      }).show()
    } catch {
      // Notification support is optional. Do not log the pairing secret.
    }
  }
}

/** Manual diagnostics choice wins over all automatic Runtime movement. */
async function resolveBootVersionSelection(userDataDir: string): Promise<BootVersionSelection> {
  const manual = await resolveManualVersionOverride(userDataDir)
  if (manual) return { version: manual }

  let pinned = ''
  try {
    pinned = (await readOriginFile(originPath())).dshVersion
  } catch {
    return {}
  }

  const cacheDir = runtimeCacheDir(userDataDir)
  const cached = await listCachedRuntimeVersions(cacheDir)
  const statePath = defaultManagedRuntimeStatePath(userDataDir)
  const state = await readManagedRuntimeState(statePath).catch(async (error) => {
    await bootLog(`runtime auto-update: managed state ignored: ${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  const selected = selectManagedRuntimeVersion(state, cached)
  if (!selected) return {}

  try {
    if (compareVersions(selected.version, pinned) <= 0) {
      await bootLog(
        `runtime auto-update: packaged pin ${pinned} supersedes managed ${selected.version}; using packaged pin`,
      )
      return {}
    }
  } catch {
    return {}
  }

  if (selected.candidate) {
    await markManagedRuntimeVerifying(statePath, selected.version)
    await bootLog(`runtime auto-update: verifying staged candidate ${selected.version}`)
    return { version: selected.version, managedCandidate: selected.version, managedStatePath: statePath }
  }

  await bootLog(`runtime auto-update: using healthy managed Runtime ${selected.version}`)
  return { version: selected.version, managedStatePath: statePath }
}

/**
 * Read userData/origin-override.json before booting. Returns the override when
 * it is non-empty and allowed (pinned / seed / cached); logs and ignores
 * anything else so a stray override can never drift the client to an arbitrary
 * version.
 */
async function resolveManualVersionOverride(userDataDir: string): Promise<string | undefined> {
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
