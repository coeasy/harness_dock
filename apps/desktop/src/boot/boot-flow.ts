import { app, Notification } from 'electron'
import { bundledRuntimeVersion } from '@dsh/client-runtime'
import { acquireRuntimeLease, LocalRuntimeProvider } from '@dsh/bootstrap'
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
 * Boot orchestration: splash → cross-host runtime lease → LocalRuntimeProvider
 * (origin → runtime → start, with last-known-good rollback) → optional secure
 * remote gateway → main window → auto-update → tray.
 *
 * The provider boundary is shared with Perry Desktop; iOS/Android implement the
 * same runtime contract through RemoteRuntimeProvider and never spawn dsh.
 */
export async function bootFlow(): Promise<void> {
  await createSplash()
  updateSplash(t('splash.loading'))
  showSplashProgress(null)

  const runtimeLease = await acquireRuntimeLease({ host: 'electron' })
  appState.runtimeLease = runtimeLease
  let localProvider: LocalRuntimeProvider | undefined

  try {
    const userDataDir = app.getPath('userData')
    const versionOverride = await resolveVersionOverride(userDataDir)

    localProvider = new LocalRuntimeProvider({
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

    const session = await localProvider.connect()
    const result = localProvider.bootstrapResult
    if (!result) throw new Error('LocalRuntimeProvider connected without a bootstrap result.')

    appState.runtime = result.runtime
    appState.dshPid = result.ready.pid
    appState.dshVersion = result.ready.dshVersion
    appState.mode = result.mode
    appState.bundledAvailable = result.bundledAvailable
    await runtimeLease.updateRuntime({
      runtimePid: result.ready.pid,
      dshVersion: result.ready.dshVersion,
    })
    await bootLog(`dsh web ready at ${session.appUrl} (pid ${result.ready.pid})`)
    await startRemoteGatewayIfEnabled(session.appUrl)
    updateSplash(t('splash.loadingInterface'))
    await createWindow(session.appUrl)

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
  } catch (error) {
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

  // Explicit opt-in only: pairing codes are credentials and must never be
  // silently written to disk logs. A preview user can request one native toast
  // at startup while the diagnostics/pairing UI is developed.
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
