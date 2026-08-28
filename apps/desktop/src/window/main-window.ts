import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { appState } from '../state.ts'
import { bootLog } from '../boot-log.ts'
import { suggestedDownloadPath } from '../downloads.ts'
import { closeSplash } from '../splash.ts'
import { fmt, t } from '../i18n.ts'
import { appIconPath, preloadPath } from '../paths.ts'
import {
  isBoundsOnScreen,
  readWindowStateSync,
  writeWindowState,
} from '../window-state.ts'

let windowIpcRegistered = false

/** Create the main frameless window that loads the official dsh Web UI. */
export async function createWindow(url: string): Promise<void> {
  const state = readWindowStateSync()
  // Frameless everywhere; macOS keeps the native traffic lights (hiddenInset),
  // Windows/Linux draw their own caption buttons in the preload caption bar.
  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'HarnessDock',
    frame: false,
    backgroundColor: '#0b1120',
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  if (state.bounds && isBoundsOnScreen(state.bounds)) {
    opts.x = state.bounds.x
    opts.y = state.bounds.y
    opts.width = state.bounds.width
    opts.height = state.bounds.height
  }
  const mainWindow = new BrowserWindow(opts)
  appState.mainWindow = mainWindow
  // Guarantee the brand icon on the window / taskbar regardless of exe-icon cache.
  try {
    mainWindow.setIcon(nativeImage.createFromPath(appIconPath()))
  } catch {
    // icon unavailable; fall back to the exe resource
  }
  if (state.maximized) mainWindow.maximize()
  registerWindowIpc()
  pushWindowState(mainWindow)
  // Persist geometry on close so the next launch restores it.
  const persist = (): void => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return
    const bounds = appState.mainWindow.getNormalBounds()
    writeWindowState({ bounds, maximized: appState.mainWindow.isMaximized() })
  }
  mainWindow.on('close', (event) => {
    persist()
    if (!appState.quitting && process.env.DSH_TRAY !== '0') {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('maximize', () => pushWindowState(mainWindow))
  mainWindow.on('unmaximize', () => pushWindowState(mainWindow))
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    closeSplash()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  // Keep the main window inside the dsh origin; anything else is opened
  // externally (setWindowOpenHandler above) rather than navigating the app.
  const allowedOrigin = new URL(url).origin
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const dest = suggestedDownloadPath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(dest)
    item.once('done', (_evt, dlState) => {
      if (dlState === 'interrupted') {
        void dialog.showErrorBox(
          t('download.failed.title'),
          fmt(t('download.failed.detail'), { path: dest }),
        )
      }
    })
  })
  // Keep the first-run failure actionable: Electron can show a blank window
  // when the local server or its renderer fails after the process has started.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    void bootLog(
      `renderer: did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL}`,
    )
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const detail = message.length > 2000 ? message.slice(0, 2000) + '…' : message
    void bootLog(`renderer: console level=${level} source=${sourceId}:${line} ${detail}`)
  })
  await mainWindow.loadURL(url)
  installRendererRecovery(mainWindow)
}

/** Pushes the current maximized state to the caption bar (for the restore icon). */
function pushWindowState(mainWindow: BrowserWindow): void {
  try {
    mainWindow.webContents.send('dsh:window-state', { maximized: mainWindow.isMaximized() })
  } catch {
    // window not ready yet
  }
}

/**
 * Handles the custom caption bar buttons (Windows/Linux): minimize,
 * toggle-maximize and close. Registered once for the app.
 */
function registerWindowIpc(): void {
  if (windowIpcRegistered) return
  windowIpcRegistered = true
  ipcMain.on('dsh:window', (_event, action: string) => {
    const win = appState.mainWindow
    if (!win || win.isDestroyed()) {
      void bootLog(`dsh:window received "${action}" but appState.mainWindow is ${win ? 'destroyed' : 'unset'}`)
      return
    }
    if (action === 'minimize') {
      win.minimize()
    } else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') {
      win.close()
    }
  })
}

/** Show / restore / hide the main window (tray toggle + second-instance). */
export function toggleMainWindow(): void {
  const mainWindow = appState.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    mainWindow.hide()
  }
}

/** Renderer crash / unresponsiveness auto-recovery (max 3 reloads per session). */
function installRendererRecovery(mainWindow: BrowserWindow): void {
  let reloadCount = 0
  mainWindow.webContents.on('did-finish-load', () => {
    reloadCount = 0
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    try {
      reloadCount += 1
      if (reloadCount <= 3) {
        mainWindow.webContents.reload()
        return
      }
      void dialog
        .showMessageBox(mainWindow, {
          type: 'error',
          title: t('common.appTitle'),
          message: t('crash.renderer.title'),
          detail: fmt(t('crash.renderer.detail'), { count: reloadCount, reason: details.reason }),
          buttons: [t('crash.renderer.reload'), t('crash.renderer.ignore')],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            reloadCount = 0
            mainWindow.webContents.reload()
          }
        })
        .catch(() => undefined)
    } catch {
      // never let the crash handler itself take down the app
    }
  })
  mainWindow.on('unresponsive', () => {
    try {
      // No parent window here: a frozen renderer as dialog parent can keep the
      // dialog from ever appearing (notably on macOS).
      void dialog
        .showMessageBox({
          type: 'warning',
          title: t('common.appTitle'),
          message: t('crash.unresponsive.title'),
          detail: t('crash.unresponsive.detail'),
          buttons: [t('crash.unresponsive.wait'), t('crash.unresponsive.reload')],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) {
            mainWindow.webContents.reload()
          }
        })
        .catch(() => undefined)
    } catch {
      // ignore
    }
  })
}
