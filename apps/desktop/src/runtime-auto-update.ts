import { app, dialog, Notification, powerMonitor } from 'electron'
import {
  assertBundledRuntimeIntegrity,
  bundledRuntimeVersion,
  inspectBundledRuntime,
  runtimeCacheDir,
} from '@dsh/client-runtime'
import {
  DEFAULT_UPDATE_POLICY,
  applyPlannedRuntimeUpdate,
  createUpdatePlan,
  defaultManagedRuntimeStatePath,
  fetchReleaseManifestV2,
  githubLatestReleaseManifestUrl,
  readManagedRuntimeState,
  shouldRestartAutomatically,
  shouldStageManagedRuntime,
  stageManagedRuntimeCandidate,
  type UpdateChannel,
  type UpdatePolicy,
} from '@dsh/bootstrap'
import path from 'node:path'
import { bootLog } from './boot-log.ts'
import { releasesUrl } from './auto-update.ts'
import { appState } from './state.ts'
import { readVersionOverride } from './version-override.ts'

export interface RuntimeAutoUpdateHandle {
  checkNow(): void
}

/**
 * Background Runtime updater for Thin/download mode.
 *
 * It never modifies the Runtime process that is currently serving this app.
 * A new version is prepared under runtime-cache/runtime-<target>, recorded as a
 * managed candidate, then activated only after a controlled app restart. Full
 * packages keep their signed bundled Runtime immutable and are skipped here.
 */
export function initRuntimeAutoUpdate(): RuntimeAutoUpdateHandle {
  let checking = false
  let idleRestartTimer: NodeJS.Timeout | undefined

  const checkNow = (): void => {
    if (checking) return
    checking = true
    void checkForRuntimeUpdate()
      .catch((error) =>
        bootLog(`runtime auto-update: check failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        checking = false
      })
  }

  if (app.isPackaged && appState.mode === 'download') {
    const first = setTimeout(checkNow, 20_000)
    first.unref()
    const periodic = setInterval(checkNow, readCheckIntervalMs(process.env))
    periodic.unref()
  } else {
    void bootLog(`runtime auto-update disabled (mode=${appState.mode ?? 'unknown'} packaged=${app.isPackaged})`)
  }

  return { checkNow }

  async function checkForRuntimeUpdate(): Promise<void> {
    if (!app.isPackaged || appState.mode !== 'download') return
    const currentVersion = appState.dshVersion
    if (!currentVersion) return

    // A manual diagnostics version choice is an explicit user pin. Automatic
    // Runtime movement must not silently override it.
    const manualOverride = await readVersionOverride()
    if (manualOverride) {
      await bootLog(`runtime auto-update skipped: manual Runtime override ${manualOverride} is active`)
      return
    }

    const manifestUrl = resolveManifestUrl()
    if (!manifestUrl) {
      await bootLog('runtime auto-update skipped: no release manifest URL available')
      return
    }

    const manifest = await fetchReleaseManifestV2(manifestUrl)
    const plan = createUpdatePlan(manifest, {
      host: 'electron',
      hostVersion: app.getVersion(),
      runtimeVersion: currentVersion,
      runtimeMode: 'thin',
      runtimeManaged: true,
      platform: process.platform,
      arch: process.arch,
      channel: inferReleaseChannel(app.getVersion()),
    })
    const delivery = plan?.runtime
    if (!delivery) return

    const targetVersion = delivery.artifact.version
    const statePath = defaultManagedRuntimeStatePath(app.getPath('userData'))
    const state = await readManagedRuntimeState(statePath)
    if (!shouldStageManagedRuntime(state, targetVersion)) {
      await bootLog(`runtime auto-update: target ${targetVersion} already staged/active/quarantined`)
      return
    }

    const cacheDir = runtimeCacheDir(app.getPath('userData'))
    const baseRuntimeDir = path.join(cacheDir, `runtime-${currentVersion}`)
    const targetRuntimeDir = path.join(cacheDir, `runtime-${targetVersion}`)
    const targetReady = await isVerifiedRuntime(targetRuntimeDir, targetVersion)

    if (!targetReady) {
      await bootLog(
        `runtime auto-update: preparing ${currentVersion} -> ${targetVersion} via ${delivery.mode}`,
      )
      const result = await applyPlannedRuntimeUpdate({
        manifest,
        delivery,
        runtimeDir: targetRuntimeDir,
        baseRuntimeDir,
        platform: process.platform,
        arch: process.arch,
        log: (message) => void bootLog(message),
      })
      await bootLog(
        `runtime auto-update: candidate ${targetVersion} prepared via ${result.delivery}` +
          `${result.fellBackFromDelta ? ' (delta fallback)' : ''}`,
      )
    } else {
      await bootLog(`runtime auto-update: reusing already verified candidate ${targetVersion}`)
    }

    await stageManagedRuntimeCandidate(statePath, {
      currentVersion,
      targetVersion,
    })
    notifyRuntimeReady(targetVersion)

    const policy = readRestartPolicy(process.env)
    if (policy.restart === 'immediate') {
      restartForRuntimeUpdate(targetVersion, 'policy=immediate')
      return
    }
    if (policy.restart === 'idle') {
      scheduleIdleRestart(targetVersion, policy)
      return
    }

    const { response } = await dialog
      .showMessageBox({
        type: 'info',
        title: 'HarnessDock Runtime Update',
        message: `DeepSeek Harness Runtime ${targetVersion} is ready.`,
        detail: 'Restart HarnessDock now to activate it. The current Runtime remains available for automatic rollback if the new version fails its startup health check.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .catch(() => ({ response: 1 }))
    if (response === 0) restartForRuntimeUpdate(targetVersion, 'user-confirmed')
  }

  function scheduleIdleRestart(version: string, policy: UpdatePolicy): void {
    if (idleRestartTimer) clearInterval(idleRestartTimer)
    const checkIdle = (): void => {
      let idleSeconds = 0
      try {
        idleSeconds = powerMonitor.getSystemIdleTime()
      } catch {
        return
      }
      if (shouldRestartAutomatically(policy, { idleSeconds })) {
        if (idleRestartTimer) clearInterval(idleRestartTimer)
        idleRestartTimer = undefined
        restartForRuntimeUpdate(version, `idle ${idleSeconds}s`)
      }
    }
    checkIdle()
    if (!idleRestartTimer) {
      idleRestartTimer = setInterval(checkIdle, 30_000)
      idleRestartTimer.unref()
    }
  }
}

async function isVerifiedRuntime(runtimeDir: string, version: string): Promise<boolean> {
  try {
    if (!inspectBundledRuntime(runtimeDir, process.platform)) return false
    if (bundledRuntimeVersion(runtimeDir) !== version) return false
    await assertBundledRuntimeIntegrity(runtimeDir, process.platform, process.arch)
    return true
  } catch {
    return false
  }
}

function restartForRuntimeUpdate(version: string, reason: string): void {
  void bootLog(`runtime auto-update: restarting to activate ${version} (${reason})`)
  try {
    app.relaunch()
  } catch {
    // If relaunch is unavailable, normal shutdown still preserves the staged
    // candidate and the next user launch will activate it.
  }
  app.quit()
}

function notifyRuntimeReady(version: string): void {
  try {
    new Notification({
      title: 'HarnessDock Runtime Update',
      body: `Runtime ${version} is ready and will activate after restart.`,
    }).show()
  } catch {
    // notifications unavailable
  }
}

function resolveManifestUrl(): string | null {
  const override = process.env.HARNESSDOCK_RELEASE_MANIFEST_URL
  if (override) return override
  const url = releasesUrl()
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 3 || parts[2] !== 'releases') return null
    return githubLatestReleaseManifestUrl(`${parts[0]}/${parts[1]}`)
  } catch {
    return null
  }
}

function inferReleaseChannel(version: string): UpdateChannel {
  const normalized = version.toLowerCase()
  if (normalized.includes('nightly') || normalized.includes('dev')) return 'nightly'
  if (normalized.includes('-')) return 'beta'
  return 'stable'
}

function readRestartPolicy(env: NodeJS.ProcessEnv): UpdatePolicy {
  const restart = env.HARNESSDOCK_UPDATE_RESTART
  const normalizedRestart: UpdatePolicy['restart'] =
    restart === 'immediate' || restart === 'idle' || restart === 'prompt'
      ? restart
      : DEFAULT_UPDATE_POLICY.restart
  const idleRaw = Number.parseInt(env.HARNESSDOCK_UPDATE_IDLE_SECONDS ?? '', 10)
  return {
    ...DEFAULT_UPDATE_POLICY,
    restart: normalizedRestart,
    idleSeconds: Number.isInteger(idleRaw) && idleRaw >= 30 ? idleRaw : DEFAULT_UPDATE_POLICY.idleSeconds,
  }
}

function readCheckIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.HARNESSDOCK_UPDATE_CHECK_INTERVAL_MINUTES ?? '', 10)
  const minutes = Number.isInteger(raw) && raw >= 15 ? raw : 240
  return minutes * 60_000
}
