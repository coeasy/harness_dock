import { app, dialog, Menu } from 'electron'
import {
  commitHostUpdateHealth,
  defaultUpdateJournalPath,
  markHostUpdateVerifying,
  recordHostUpdateFailure,
} from '@dsh/bootstrap'
import { bootLog, getLogDir, getLogFile, pruneOldLogs } from './boot-log.ts'
import { appState } from './state.ts'
import { installCrashGuard } from './boot/crash-guard.ts'
import { bootFlow } from './boot/boot-flow.ts'
import { beginShutdown } from './shutdown.ts'
import { registerSplashIpc, showSplashError } from './splash.ts'
import { registerDiagnosticsIpc } from './diagnostics/diagnostics-ipc.ts'
import { registerMobileIpc } from './mobile/mobile-ipc.ts'
import { fmt, t } from './i18n.ts'
import { bundledRoot, originPath, pluginPath } from './paths.ts'

// ---------- single instance lock ----------
// Re-launching the app just focuses the existing window instead of starting
// a second dsh process tree (which would race on the same port / data dir).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  const mainWindow = appState.mainWindow
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  appState.quitting = true
  beginShutdown(event)
})

installCrashGuard()

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.dsh.client')
  } catch {
    // non-fatal
  }
}

registerSplashIpc()
registerDiagnosticsIpc()
registerMobileIpc()

/** Restart the whole app (used by boot-failure retry). */
function relaunchApp(): void {
  try {
    app.relaunch()
  } catch {
    // relaunch unavailable (dev / bare electron); fall through to exit
  }
  app.exit(0)
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await bootLog(
      `boot start | version=${app.getVersion()} packaged=${app.isPackaged} resources=${process.resourcesPath ?? '?'} electron=${process.versions.electron}`,
    )
    await pruneOldLogs()
    await bootLog(`log dir: ${getLogDir()}`)

    const updateJournal = defaultUpdateJournalPath(app.getPath('userData'))
    try {
      const verifying = await markHostUpdateVerifying(updateJournal, app.getVersion())
      if (verifying?.phase === 'verifying') {
        await bootLog(
          `auto-update: post-restart health gate started ${verifying.previousHostVersion} -> ${verifying.targetHostVersion} (attempt ${verifying.attempt})`,
        )
      }
    } catch (error) {
      // A malformed journal must never block a known-good installed Host from
      // booting. Log it and leave recovery inspection to diagnostics.
      await bootLog(
        `auto-update: recovery journal read failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      await bootLog(`plugin=${pluginPath()} | bundled=${bundledRoot()} | origin=${originPath()}`)
      await bootFlow()
      await bootLog('boot ok')
      try {
        if (await commitHostUpdateHealth(updateJournal, app.getVersion())) {
          await bootLog(`auto-update: host ${app.getVersion()} passed post-restart health gate; update committed`)
        }
      } catch (error) {
        await bootLog(
          `auto-update: failed to commit health journal: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      await bootLog(`boot FAILED: ${message}`)
      try {
        const failed = await recordHostUpdateFailure(updateJournal, app.getVersion(), error)
        if (failed?.phase === 'failed') {
          await bootLog(
            `auto-update: new host ${failed.targetHostVersion} failed health gate (attempt ${failed.attempt}); previous=${failed.previousHostVersion}`,
          )
        }
      } catch (journalError) {
        await bootLog(
          `auto-update: failed to record health failure: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
        )
      }

      showSplashError({ message, onRetry: relaunchApp })
      const { response } = await dialog
        .showMessageBox({
          type: 'error',
          title: t('boot.failed.title'),
          message: t('boot.failed.summary'),
          detail: fmt(t('boot.failed.message'), { logFile: getLogFile() }),
          buttons: [t('boot.failed.retry'), t('common.close')],
          defaultId: 0,
          cancelId: 1,
        })
        .catch(() => ({ response: 1 }))
      if (response === 0) relaunchApp()
      app.quit()
    }
  })
}
