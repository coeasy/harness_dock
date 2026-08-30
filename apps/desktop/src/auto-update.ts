import { app, dialog, Notification, powerMonitor, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  DEFAULT_UPDATE_POLICY,
  shouldRestartAutomatically,
  type UpdatePolicy,
} from '@dsh/bootstrap'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { bootLog } from './boot-log.ts'
import { fmt, t } from './i18n.ts'

/**
 * Electron Stable update adapter.
 *
 * Host-neutral package selection / runtime planning lives in @dsh/bootstrap.
 * This file only adapts electron-updater to that policy:
 *
 *  - startup + periodic update checks;
 *  - background downloads (NSIS blockmap differential when available);
 *  - install-on-quit by default;
 *  - optional automatic restart immediately or when the system is idle;
 *  - force-run the new app after quitAndInstall so an automatic update really
 *    completes as one transaction from the user's perspective.
 *
 * Portable single-file executables still cannot safely replace themselves and
 * therefore degrade to the GitHub Releases page.
 */

export function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
}

/** true when a publish feed was baked into this build (resources/app-update.yml). */
export function hasUpdateFeed(): boolean {
  try {
    return existsSync(path.join(process.resourcesPath, 'app-update.yml'))
  } catch {
    return false
  }
}

export function releasesUrl(): string | null {
  const override = process.env.DSH_RELEASES_URL
  if (override) return override
  try {
    const raw = readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const owner = /(?:^|\n)\s*owner:\s*["']?([^"'\s]+)/.exec(raw)?.[1]
    const repo = /(?:^|\n)\s*repo:\s*["']?([^"'\s]+)/.exec(raw)?.[1]
    if (owner && repo) return `https://github.com/${owner}/${repo}/releases`
  } catch {
    // no feed baked in
  }
  return null
}

export interface AutoUpdateHandle {
  checkNow(): void
  openReleasesPage(): void
}

function notify(title: string, body: string): void {
  try {
    const n = new Notification({ title, body })
    n.show()
  } catch {
    // notifications unavailable
  }
}

export function initAutoUpdate(): AutoUpdateHandle {
  const disabledReason = !app.isPackaged
    ? 'not packaged'
    : isPortable()
      ? 'portable single-file exe'
      : !hasUpdateFeed()
        ? 'no publish feed (set GH_OWNER/GH_REPO at build time)'
        : null

  if (disabledReason) {
    void bootLog(`auto-update disabled (${disabledReason})`)
    return { checkNow: openReleasesPage, openReleasesPage }
  }

  const policy = readUpdatePolicy(process.env)
  const checkIntervalMs = readCheckIntervalMs(process.env)
  void bootLog(
    `auto-update enabled (current=${app.getVersion()} feed=${releasesUrl() ?? 'unknown'} download=${policy.download} install=${policy.install} restart=${policy.restart})`,
  )

  autoUpdater.autoDownload = policy.download === 'automatic'
  autoUpdater.autoInstallOnAppQuit = process.env.HARNESSDOCK_UPDATE_INSTALL_ON_QUIT !== '0'
  if (process.env.DSH_UPDATE_FEED_URL) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_UPDATE_FEED_URL })
  }

  autoUpdater.on('checking-for-update', () => void bootLog('auto-update: checking for updates'))
  autoUpdater.on('update-available', (info) => {
    void bootLog(`auto-update: update available ${app.getVersion()} -> ${info.version}`)
    notify(t('update.available.title'), fmt(t('update.available.body'), { version: info.version }))
  })
  autoUpdater.on('update-not-available', () => void bootLog('auto-update: up to date'))
  autoUpdater.on('error', (error) => {
    void bootLog(`auto-update: error: ${error instanceof Error ? error.message : String(error)}`)
  })

  let lastLoggedPercent = 0
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.floor(progress.percent)
    if (percent >= lastLoggedPercent + 10) {
      lastLoggedPercent = percent
      void bootLog(
        `auto-update: download ${percent}% (${Math.round(progress.transferred / 1024)}/${Math.round(progress.total / 1024)} KB)`,
      )
    }
  })

  let idleRestartTimer: NodeJS.Timeout | undefined
  const clearIdleRestart = (): void => {
    if (!idleRestartTimer) return
    clearInterval(idleRestartTimer)
    idleRestartTimer = undefined
  }

  const installAndRestart = (version: string, reason: string): void => {
    clearIdleRestart()
    void bootLog(`auto-update: installing ${version} and restarting (${reason})`)
    // before-quit continues through the normal HarnessDock shutdown path, which
    // stops dsh/gateway and releases the Runtime Lease before Electron exits.
    autoUpdater.quitAndInstall(false, true)
  }

  const scheduleIdleRestart = (version: string): void => {
    clearIdleRestart()
    const checkIdle = (): void => {
      let idleSeconds = 0
      try {
        idleSeconds = powerMonitor.getSystemIdleTime()
      } catch {
        return
      }
      if (shouldRestartAutomatically(policy, { idleSeconds })) {
        installAndRestart(version, `idle ${idleSeconds}s`)
      }
    }
    checkIdle()
    if (!idleRestartTimer) {
      idleRestartTimer = setInterval(checkIdle, 30_000)
      idleRestartTimer.unref()
    }
  }

  autoUpdater.on('update-downloaded', (info) => {
    void bootLog(`auto-update: update downloaded (${info.version}), ready to install`)
    notify(t('update.downloaded.title'), fmt(t('update.downloaded.body'), { version: info.version }))

    if (policy.restart === 'immediate') {
      installAndRestart(info.version, 'policy=immediate')
      return
    }
    if (policy.restart === 'idle') {
      scheduleIdleRestart(info.version)
      return
    }

    void dialog
      .showMessageBox({
        type: 'info',
        title: t('common.appTitle'),
        message: fmt(t('update.restart.title'), { version: info.version }),
        detail: t('update.restart.detail'),
        buttons: [t('update.restart.now'), t('update.restart.later')],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) installAndRestart(info.version, 'user-confirmed')
      })
      .catch(() => undefined)
  })

  let checking = false
  const checkNow = (): void => {
    if (checking) {
      void bootLog('auto-update: check skipped (already checking)')
      return
    }
    checking = true
    void autoUpdater
      .checkForUpdates()
      .then((result) => void bootLog(`auto-update: check resolved (${result?.updateInfo.version ?? 'n/a'})`))
      .catch((error) => void bootLog(`auto-update: check failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        checking = false
      })
  }

  // Startup check never delays boot. Periodic checks keep long-running tray
  // sessions current without requiring the user to relaunch HarnessDock.
  const first = setTimeout(() => checkNow(), 5_000)
  first.unref()
  const periodic = setInterval(() => checkNow(), checkIntervalMs)
  periodic.unref()

  return { checkNow, openReleasesPage }
}

function readUpdatePolicy(env: NodeJS.ProcessEnv): UpdatePolicy {
  const restart = env.HARNESSDOCK_UPDATE_RESTART
  const normalizedRestart: UpdatePolicy['restart'] =
    restart === 'immediate' || restart === 'idle' || restart === 'prompt' ? restart : DEFAULT_UPDATE_POLICY.restart
  const idleRaw = Number.parseInt(env.HARNESSDOCK_UPDATE_IDLE_SECONDS ?? '', 10)
  const idleSeconds = Number.isInteger(idleRaw) && idleRaw >= 30 ? idleRaw : DEFAULT_UPDATE_POLICY.idleSeconds
  return {
    ...DEFAULT_UPDATE_POLICY,
    download: env.HARNESSDOCK_UPDATE_AUTO_DOWNLOAD === '0' ? 'manual' : 'automatic',
    install: env.HARNESSDOCK_UPDATE_INSTALL === 'immediate' || env.HARNESSDOCK_UPDATE_INSTALL === 'idle'
      ? env.HARNESSDOCK_UPDATE_INSTALL
      : DEFAULT_UPDATE_POLICY.install,
    restart: normalizedRestart,
    idleSeconds,
  }
}

function readCheckIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.HARNESSDOCK_UPDATE_CHECK_INTERVAL_MINUTES ?? '', 10)
  const minutes = Number.isInteger(raw) && raw >= 15 ? raw : 240
  return minutes * 60_000
}

export function openReleasesPage(): void {
  const url = releasesUrl()
  if (url) {
    void shell.openExternal(url)
    return
  }
  void bootLog('auto-update: no releases URL available (feed missing); cannot open page')
  notify(t('update.available.title'), t('update.noFeed.body'))
}
