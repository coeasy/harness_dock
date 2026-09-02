import { app, BrowserWindow, ipcMain } from 'electron'
import type { ShellCommandName } from '@dsh/bootstrap/client-core'
import { openDiagnosticsWindow } from './diagnostics/diagnostics.ts'
import { createElectronRuntimeService } from './runtime-controller.ts'
import { appState } from './state.ts'
import { bootLog } from './boot-log.ts'

let registered = false

const CAPABILITIES: Record<ShellCommandName, boolean> = {
  'window.minimize': true,
  'window.toggleMaximize': true,
  'window.state': true,
  'window.close': true,
  'web.reload': true,
  'web.restart': true,
  // The canonical Tauri host owns the temporary-profile safe mode. Electron
  // remains a compatibility host and hides this action instead of presenting
  // a button that cannot provide the same guarantee.
  'runtime.safe-mode': false,
  'runtime.clear-quarantine': true,
  'diagnostics.open': true,
  'app.update.check': true,
  'app.update.install': true,
  'app.quit': true,
}

function assertMainWindow(sender: Electron.WebContents): BrowserWindow {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window !== appState.mainWindow || window.isDestroyed()) {
    throw new Error('Shell command sender is not the Harness Web window')
  }
  return window
}

async function dispatch(window: BrowserWindow, command: ShellCommandName): Promise<unknown> {
  switch (command) {
    case 'window.minimize':
      window.minimize()
      return undefined
    case 'window.toggleMaximize':
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return { maximized: window.isMaximized() }
    case 'window.state':
      return { maximized: window.isMaximized() }
    case 'window.close':
      window.close()
      return undefined
    case 'web.reload':
      window.webContents.reload()
      return undefined
    case 'web.restart':
      return createElectronRuntimeService().restart()
    case 'runtime.clear-quarantine':
      await appState.runtime?.clearPluginQuarantine()
      return createElectronRuntimeService().restart()
    case 'diagnostics.open':
      openDiagnosticsWindow('info')
      return undefined
    case 'app.update.check': {
      const service = appState.updates ?? appState.hostUpdate
      if (!service) throw new Error('GitHub 更新服务尚未就绪')
      return service.check('host')
    }
    case 'app.update.install': {
      const service = appState.updates ?? appState.hostUpdate
      if (!service) throw new Error('GitHub 更新服务尚未就绪')
      const snapshot = await service.state('host')
      if (snapshot.phase !== 'ready') return service.check('host')
      await service.install('host')
      return undefined
    }
    case 'app.quit':
      app.quit()
      return undefined
    case 'runtime.safe-mode':
      throw new Error('Electron 兼容外壳不支持安全配置启动，请使用 Tauri v0.2.0')
  }
}

export function registerShellIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle('dsh:shell-capabilities', () => ({ ...CAPABILITIES }))
  ipcMain.handle('dsh:shell', async (event, command: unknown) => {
    const window = assertMainWindow(event.sender)
    if (typeof command !== 'string' || !(command in CAPABILITIES)) {
      throw new Error(`Unsupported shell command: ${String(command)}`)
    }
    const shellCommand = command as ShellCommandName
    if (!CAPABILITIES[shellCommand]) throw new Error(`Shell command unavailable: ${shellCommand}`)
    try {
      return await dispatch(window, shellCommand)
    } catch (error) {
      void bootLog(
        `shell command failed (${shellCommand}): ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  })
}
