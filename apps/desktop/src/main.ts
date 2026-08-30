import { app, dialog, Menu } from 'electron'
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
  // Another instance is already running. Hand the focus over and exit.
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
  // macOS convention: a Dock app stays alive (and reachable via the tray) when
  // all windows close; quit happens through the tray menu / Cmd+Q. Elsewhere
  // closing the window quits (or hides to tray via the close handler above).
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  appState.quitting = true
  beginShutdown(event)
})

installCrashGuard()

// Windows: proper app identity for notifications / toast and taskbar grouping.
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.dsh.client')
  } catch {
    // non-fatal
  }
}

// Helper windows are sandboxed data: URLs; their preload bridges reach back
// through these IPC channels, so they must be registered up front.
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
      `boot start | packaged=${app.isPackaged} resources=${process.resourcesPath ?? '?'} electron=${process.versions.electron}`,
    )
    await pruneOldLogs()
    await bootLog(`log dir: ${getLogDir()}`)
    try {
      await bootLog(`plugin=${pluginPath()} | bundled=${bundledRoot()} | origin=${originPath()}`)
      await bootFlow()
      await bootLog('boot ok')
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      await bootLog(`boot FAILED: ${message}`)
      // Keep the native dialog, but also surface the error on the splash with
      // actionable buttons (retry / open log / copy). Quit only after the
      // dialog is dismissed so the splash retry stays usable while it is open.
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
