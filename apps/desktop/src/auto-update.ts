import { app, dialog, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { bootLog } from './boot-log.ts'
import { fmt, t } from './i18n.ts'

/**
 * Auto-update (assessment Phase A).
 *
 *  - Windows NSIS installs: check the GitHub Releases feed (resources/app-update.yml)
 *    generated from the `publish` config, download the new NSIS installer in the
 *    background (blockmap differential), install on quit.
 *  - Portable single-file exe: cannot replace itself; auto-update is disabled and
 *    "check for updates" degrades to opening the GitHub Releases page.
 *  - Development / un-packaged builds: inert.
 *
 * All events go to the boot log and are surfaced with native Notification /
 * dialog (the embedded Web UI is the official SPA and is never modified).
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

/**
 * Derive the GitHub Releases URL from the baked feed (owner/repo), so even the
 * portable build can point the user at the manual download page without any
 * hard-coded repo. `DSH_RELEASES_URL` wins when set explicitly.
 */
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
  /** Manual "check for updates" (tray menu). Handles portable / dev / no-feed degrade. */
  checkNow(): void
  /** Open the project's GitHub Releases page (used by the portable degrade path). */
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

  void bootLog(`auto-update enabled (feed: ${releasesUrl() ?? 'unknown'})`)

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  if (process.env.DSH_UPDATE_FEED_URL) {
    // Unofficial/self-hosted feed override for testing.
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_UPDATE_FEED_URL })
  }

  autoUpdater.on('checking-for-update', () => void bootLog('auto-update: checking for updates'))
  autoUpdater.on('update-available', (info) => {
    void bootLog(`auto-update: update available ${info.version}`)
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

  autoUpdater.on('update-downloaded', (info) => {
    void bootLog(`auto-update: update downloaded (${info.version}), ready to install`)
    notify(t('update.downloaded.title'), fmt(t('update.downloaded.body'), { version: info.version }))
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
        if (response === 0) autoUpdater.quitAndInstall()
      })
      .catch(() => undefined)
  })

  const checkNow = (): void => {
    void autoUpdater
      .checkForUpdates()
      .then((result) => void bootLog(`auto-update: checkForUpdates resolved (${result?.updateInfo.version ?? 'n/a'})`))
      .catch((error) => void bootLog(`auto-update: check failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  // First check shortly after startup so it never delays boot.
  const first = setTimeout(() => checkNow(), 5_000)
  first.unref()

  return { checkNow, openReleasesPage }
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
