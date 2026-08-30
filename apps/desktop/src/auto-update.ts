import { app, dialog, Notification, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { autoUpdater } from 'electron-updater'
import type {
  HostUpdateInfo,
  UpdateService,
  UpdateSnapshot,
  UpdateTarget,
} from '@dsh/bootstrap/client-core'
import { bootLog } from './boot-log.ts'
import { fmt, t } from './i18n.ts'
import { appState } from './state.ts'
import { HostUpdateStateMachine } from './host-update-state.ts'
import { captureCurrentSessionSnapshot } from './session-snapshot.ts'

export interface AutoUpdateHandle {
  service: UpdateService
  checkNow(): void
  openReleasesPage(): void
}

export class UnsupportedElectronUpdateTargetError extends Error {
  constructor(readonly target: UpdateTarget) {
    super(`Electron host updater only manages the host application, not ${target} updates`)
    this.name = 'UnsupportedElectronUpdateTargetError'
  }
}

export class HostUpdateUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Host auto-update is unavailable: ${reason}`)
    this.name = 'HostUpdateUnavailableError'
  }
}

function assertHostTarget(target: UpdateTarget): void {
  if (target !== 'host') throw new UnsupportedElectronUpdateTargetError(target)
}

function appUpdateYmlPath(): string {
  return path.join(process.resourcesPath, 'app-update.yml')
}

export function hasUpdateFeed(): boolean {
  return existsSync(appUpdateYmlPath())
}

function portableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
}

function releasesUrl(): string {
  const override = process.env.DSH_RELEASES_URL?.trim()
  if (override) return override
  try {
    const raw = readFileSync(appUpdateYmlPath(), 'utf8')
    const owner = raw.match(/^owner:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim()
    const repo = raw.match(/^repo:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim()
    if (owner && repo) return `https://github.com/${owner}/${repo}/releases/latest`
  } catch {
    // fall through
  }
  return 'https://github.com/coeasy/harness_dock/releases/latest'
}

async function openReleasesPage(): Promise<void> {
  await shell.openExternal(releasesUrl())
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {
    // optional integration
  }
}

function releaseNotes(info: { releaseNotes?: unknown }): string | undefined {
  return typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
}

class ElectronHostUpdateService implements UpdateService {
  private readonly machine = new HostUpdateStateMachine()
  private available: HostUpdateInfo | null = null

  constructor(private readonly disabledReason?: string) {}

  async state(target: UpdateTarget): Promise<UpdateSnapshot> {
    assertHostTarget(target)
    return this.machine.state()
  }

  async check(target: UpdateTarget): Promise<HostUpdateInfo | null> {
    assertHostTarget(target)
    this.assertEnabled()
    const current = this.machine.state()
    if (current.phase === 'checking') return this.available
    this.machine.beginCheck(app.getVersion())
    try {
      const result = await autoUpdater.checkForUpdates()
      if (this.machine.state().phase === 'checking') {
        const nextVersion = result?.updateInfo?.version
        if (nextVersion && nextVersion !== app.getVersion()) this.onAvailable(result.updateInfo)
        else this.onNotAvailable()
      }
      return this.available
    } catch (error) {
      this.onError(error)
      throw error
    }
  }

  async download(target: UpdateTarget): Promise<void> {
    assertHostTarget(target)
    this.assertEnabled()
    const phase = this.machine.state().phase
    if (phase === 'ready') return
    if (phase !== 'available' && phase !== 'downloading') {
      throw new Error(`Host update is not ready to download (state=${phase})`)
    }
    this.machine.markDownloadStarted()
    try {
      await autoUpdater.downloadUpdate()
      this.machine.markDownloaded()
    } catch (error) {
      this.onError(error)
      throw error
    }
  }

  async install(target: UpdateTarget): Promise<void> {
    assertHostTarget(target)
    this.assertEnabled()
    if (this.machine.state().phase !== 'ready') {
      throw new Error(`Host update is not ready to install (state=${this.machine.state().phase})`)
    }
    await captureCurrentSessionSnapshot().catch((error) => {
      void bootLog(`auto-update snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.machine.beginInstall()
    autoUpdater.quitAndInstall()
  }

  async rollback(target: UpdateTarget): Promise<void> {
    assertHostTarget(target)
    throw new Error('Automatic host rollback is not implemented for Electron; use the LTS installer fallback')
  }

  onChecking(): void {
    try {
      this.machine.beginCheck(app.getVersion())
    } catch {
      // duplicate native checking event
    }
  }

  onAvailable(info: { version: string; releaseNotes?: unknown }): void {
    this.available = {
      target: 'host',
      currentVersion: app.getVersion(),
      nextVersion: info.version,
      notes: releaseNotes(info),
    }
    try {
      this.machine.markAvailable(info.version)
    } catch (error) {
      this.machine.markFailure(error)
    }
  }

  onNotAvailable(): void {
    this.available = null
    this.machine.markNoUpdate()
  }

  onDownloadProgress(percent: number): void {
    try {
      this.machine.markDownloadProgress(percent)
    } catch (error) {
      this.machine.markFailure(error)
    }
  }

  onDownloaded(): void {
    try {
      this.machine.markDownloaded()
    } catch (error) {
      this.machine.markFailure(error)
    }
  }

  onError(error: unknown): void {
    this.machine.markFailure(error)
  }

  private assertEnabled(): void {
    if (this.disabledReason) throw new HostUpdateUnavailableError(this.disabledReason)
  }
}

function disabledHandle(reason: string): AutoUpdateHandle {
  const service = new ElectronHostUpdateService(reason)
  appState.hostUpdate = service
  return {
    service,
    checkNow: () => {
      void bootLog(`auto-update disabled: ${reason}; opening releases page`)
      void openReleasesPage()
    },
    openReleasesPage: () => void openReleasesPage(),
  }
}

export function initAutoUpdate(): AutoUpdateHandle {
  if (!app.isPackaged) return disabledHandle('development build')
  if (portableBuild()) return disabledHandle('portable build cannot replace its running executable')
  if (!hasUpdateFeed() && !process.env.DSH_UPDATE_FEED_URL?.trim()) {
    return disabledHandle('package has no update feed')
  }

  const service = new ElectronHostUpdateService()
  appState.hostUpdate = service

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = app.getVersion().includes('-')

  const genericFeed = process.env.DSH_UPDATE_FEED_URL?.trim()
  if (genericFeed) autoUpdater.setFeedURL({ provider: 'generic', url: genericFeed })

  autoUpdater.on('checking-for-update', () => {
    service.onChecking()
    void bootLog('auto-update: checking')
  })
  autoUpdater.on('update-available', (info) => {
    service.onAvailable(info)
    void bootLog(`auto-update: available ${info.version}`)
    notify(t('update.available.title'), fmt(t('update.available.body'), { version: info.version }))
  })
  autoUpdater.on('update-not-available', (info) => {
    service.onNotAvailable()
    void bootLog(`auto-update: no update (${info.version})`)
  })
  autoUpdater.on('download-progress', (progress) => {
    service.onDownloadProgress(progress.percent)
    void bootLog(`auto-update: downloading ${Math.floor(progress.percent)}% (${progress.transferred}/${progress.total})`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    service.onDownloaded()
    void bootLog(`auto-update: downloaded ${info.version}; waiting for restart`)
    notify(t('update.downloaded.title'), fmt(t('update.downloaded.body'), { version: info.version }))
    void dialog
      .showMessageBox({
        type: 'info',
        title: t('update.downloaded.title'),
        message: fmt(t('update.downloaded.body'), { version: info.version }),
        detail: t('update.restart.detail'),
        buttons: [t('update.restart.now'), t('update.restart.later')],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          void service.install('host').catch((error) => {
            void bootLog(`auto-update install failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      })
  })
  autoUpdater.on('error', (error) => {
    service.onError(error)
    void bootLog(`auto-update error: ${error instanceof Error ? error.message : String(error)}`)
  })

  const checkNow = (): void => {
    void service.check('host').catch((error) => {
      void bootLog(`auto-update check failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const firstCheck = setTimeout(checkNow, 5_000)
  firstCheck.unref()

  return {
    service,
    checkNow,
    openReleasesPage: () => void openReleasesPage(),
  }
}
