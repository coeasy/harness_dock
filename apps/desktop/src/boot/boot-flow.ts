import { app, Notification } from 'electron'
import { bundledRuntimeVersion, redactWebAuthTokens } from '@dsh/client-runtime'
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
import { openMobileManagerWindow } from '../mobile/mobile-window.ts'
import { bundledRoot, compatibilityPath, originPath, pluginPath, shellPluginPath } from '../paths.ts'
import {
  isAllowedVersion,
  listCachedRuntimeVersions,
  readVersionOverride,
  runtimeCacheDir,
} from '../version-override.ts'
import {
  createElectronRuntimeService,
  startRuntimeLeaseHeartbeat,
  startRuntimeSupervisor,
  stopRuntimeLeaseHeartbeat,
} from '../runtime-controller.ts'
import {
  createCompositeUpdateService,
  createElectronRuntimeUpdateService,
  resolveManagedRuntimeSelection,
  rollbackManagedRuntimeSelection,
} from '../runtime-update-service.ts'

let autoUpdate: AutoUpdateHandle | undefined

export async function bootFlow(): Promise<void> {
  await createSplash()
  updateSplash(t('splash.loading'))
  showSplashProgress(null)

  const runtimeLease = await acquireRuntimeLease({ host: 'electron', protocolVersion: 1 })
  appState.runtimeLease = runtimeLease
  appState.runtimeState = 'connecting'
  let localProvider: LocalRuntimeProvider | undefined
  let managedSelection: { version: string; directory: string } | null = null
  let userDataDir: string | undefined
  let runtimeConnected = false
  let runtimeStartAttempted = false

  try {
    const resolvedUserDataDir = app.getPath('userData')
    userDataDir = resolvedUserDataDir
    managedSelection = await resolveManagedRuntimeSelection(resolvedUserDataDir)
    const versionOverride = managedSelection?.version ?? await resolveVersionOverride(resolvedUserDataDir)
    const activeBundledRoot = managedSelection?.directory ?? bundledRoot()
    appState.managedRuntimeVersion = managedSelection?.version

    localProvider = new LocalRuntimeProvider({
      originPath: originPath(),
      pluginPath: pluginPath(),
      compatibilityPath: compatibilityPath(),
      shellPluginPath: shellPluginPath(),
      packaged: app.isPackaged,
      bundledRoot: activeBundledRoot,
      userDataDir: resolvedUserDataDir,
      versionOverride,
      stopTimeoutMs: 12_000,
      enableRollback: !managedSelection,
      log: (message) => void bootLog(message),
      onBeforeStart: ({ bundledAvailable }) => {
        showSplashProgress(null)
        void bootLog(
          `runtime mode: ${bundledAvailable ? 'bundled (offline)' : `download (${process.platform}/${process.arch} first-launch runtime only)`}`,
        )
        if (managedSelection) {
          void bootLog(`runtime source: managed canonical artifact ${managedSelection.version}`)
        }
        if (bundledAvailable) {
          updateSplash(t('splash.startingRuntime'))
        } else {
          updateSplash(t('splash.firstLaunch'))
          showFirstLaunchHints()
        }
      },
      onProgress: (event) => {
        if (event.stage === 'fetch') {
          showSplashProgress(event.percent)
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
          showSplashProgress(100)
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

    runtimeStartAttempted = true
    const session = await localProvider.connect()
    runtimeConnected = true
    const result = localProvider.bootstrapResult
    if (!result) throw new Error('LocalRuntimeProvider connected without a bootstrap result.')

    appState.runtimeProvider = localProvider
    appState.runtime = result.runtime
    appState.dshPid = result.ready.pid
    appState.dshVersion = result.ready.dshVersion
    appState.runtimeAppUrl = session.appUrl
    appState.runtimeEndpoint = new URL(session.appUrl).origin
    const pluginRecovery = result.runtime.pluginRecoveryState
    appState.runtimeState = pluginRecovery.active ? 'degraded' : 'ready'
    appState.mode = result.mode
    appState.bundledAvailable = result.bundledAvailable
    await runtimeLease.updateRuntime({
      runtimePid: result.ready.pid,
      runtimeId: `dsh:${result.ready.dshVersion}`,
      endpoint: appState.runtimeEndpoint,
      dshVersion: result.ready.dshVersion,
      protocolVersion: 1,
    })
    startRuntimeLeaseHeartbeat()
    startRuntimeSupervisor()
    await bootLog(`dsh web ready at ${redactWebAuthTokens(session.appUrl)} (pid ${result.ready.pid})`)
    if (pluginRecovery.active) {
      await bootLog(
        `plugin fault containment active: source=${pluginRecovery.source} isolated=${pluginRecovery.isolatedPlugins.join(', ') || 'none'} suspected=${pluginRecovery.suspectedPlugins.join(', ') || 'unknown'}`,
      )
      try {
        new Notification({
          title: t('common.appTitle'),
          body: `HarnessDock 已以兼容模式启动；本次隔离 ${pluginRecovery.isolatedPlugins.length} 个第三方插件。`,
        }).show()
      } catch {
        // notifications unavailable
      }
    }
    showSplashProgress(null)
    await startRemoteGatewayIfEnabled(session.appUrl)
    updateSplash(t('splash.loadingInterface'))
    showSplashProgress(null)
    await createWindow(session.appUrl)
    showSplashDone()

    const runtimeService = createElectronRuntimeService()
    try {
      autoUpdate = initAutoUpdate()
      const runtimeUpdate = createElectronRuntimeUpdateService(runtimeService, resolvedUserDataDir)
      appState.updates = createCompositeUpdateService(autoUpdate.service, runtimeUpdate)
    } catch (error) {
      await bootLog(`auto-update init failed: ${error instanceof Error ? error.message : String(error)}`)
      appState.updates = createElectronRuntimeUpdateService(runtimeService, resolvedUserDataDir)
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
        onRestartRuntime: () => {
          void runtimeService.restart().catch((error) => void bootLog(`runtime restart failed: ${String(error)}`))
        },
        onStopRuntime: () => {
          void runtimeService.stop().catch((error) => void bootLog(`runtime stop failed: ${String(error)}`))
        },
        getRuntimeStatus: () => ({ state: appState.runtimeState, version: appState.dshVersion }),
      })
    } catch (error) {
      await bootLog(`tray creation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } catch (error) {
    appState.runtimeSupervisorStop?.()
    appState.runtimeSupervisorStop = undefined
    stopRuntimeLeaseHeartbeat()
    appState.runtimeLease = undefined
    await appState.gateway?.stop().catch(() => undefined)
    appState.gateway = undefined
    await localProvider?.disconnect().catch(() => undefined)
    appState.runtimeProvider = undefined
    appState.runtime = undefined
    appState.dshPid = undefined
    appState.dshVersion = undefined
    appState.runtimeEndpoint = undefined
    appState.runtimeAppUrl = undefined
    appState.runtimeState = 'stopped'
    appState.mode = undefined
    appState.bundledAvailable = undefined
    await runtimeLease.release().catch(() => undefined)

    if (!runtimeConnected && managedSelection && userDataDir) {
      const rollbackVersion = await rollbackManagedRuntimeSelection(userDataDir)
      if (rollbackVersion) {
        await bootLog(
          `managed runtime ${managedSelection.version} failed during boot; rolled back to ${rollbackVersion} and relaunching`,
        )
        app.relaunch()
        app.exit(0)
        return
      }
    }

    // A dsh/plugin failure is not an Electron host failure. Keep the control
    // plane alive so the user can inspect diagnostics, clear/update plugins and
    // retry the runtime without entering an app-level crash/relaunch loop.
    if (runtimeStartAttempted && !runtimeConnected && userDataDir) {
      const message = error instanceof Error ? error.message : String(error)
      appState.runtimeState = 'degraded'
      await bootLog(`boot: runtime unavailable; continuing with host recovery shell: ${message}`)
      updateSplash('Runtime 启动失败，HarnessDock 已进入安全诊断模式。')
      showSplashProgress(null)

      const runtimeService = createElectronRuntimeService()
      try {
        appState.updates = createElectronRuntimeUpdateService(runtimeService, userDataDir)
      } catch (updateError) {
        await bootLog(`degraded shell update service failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`)
      }
      try {
        appState.tray = createTray({
          onToggle: () => openDiagnosticsWindow('info'),
          onOpenLog: () => void openLogDir(),
          onMobileDevices: openMobileManagerWindow,
          onDiagnostics: () => openDiagnosticsWindow('info'),
          onVersions: () => openDiagnosticsWindow('versions'),
          onQuit: () => app.quit(),
          onCheckUpdate: () => autoUpdate?.checkNow(),
          onRestartRuntime: () => {
            void runtimeService.connect().then((session) => createWindow(session.appUrl)).catch((restartError) => {
              void bootLog(`degraded runtime retry failed: ${String(restartError)}`)
              openDiagnosticsWindow('info')
            })
          },
          onStopRuntime: () => {
            void runtimeService.stop().catch((stopError) => void bootLog(`runtime stop failed: ${String(stopError)}`))
          },
          getRuntimeStatus: () => ({ state: appState.runtimeState, version: appState.dshVersion }),
        })
      } catch (trayError) {
        await bootLog(`degraded shell tray creation failed: ${trayError instanceof Error ? trayError.message : String(trayError)}`)
      }
      showSplashDone()
      openDiagnosticsWindow('info')
      return
    }
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
