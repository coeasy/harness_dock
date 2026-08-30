import { app, dialog, shell, type BrowserWindow } from 'electron'
import {
  ClientCommandBus,
  UnsupportedClientCommandError,
  deepLinkIntentToCommand,
  parseHarnessDockDeepLink,
  type AppLifecycleService,
  type CredentialService,
  type DiagnosticsService,
  type FilePickerOptions,
  type FileService,
  type NetworkService,
  type SaveFileOptions,
  type SessionRecoveryService,
} from '@dsh/bootstrap/client-core'
import { bootLog } from './boot-log.ts'
import { extractHarnessDockDeepLinks } from './client-activation.ts'
import {
  createElectronCredentialService,
  createElectronDiagnosticsService,
  createElectronNetworkService,
  createElectronSessionRecoveryService,
} from './electron-services.ts'
import { appState } from './state.ts'

function ownerWindow(): BrowserWindow | undefined {
  const window = appState.mainWindow
  if (!window || window.isDestroyed()) return undefined
  return window
}

export function focusElectronMainWindow(): void {
  const window = ownerWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

export function createElectronLifecycleService(): AppLifecycleService {
  return {
    async focus() {
      focusElectronMainWindow()
    },
    async quit() {
      app.quit()
    },
    async relaunch() {
      app.relaunch()
      app.exit(0)
    },
  }
}

function fileFilters(
  filters: FilePickerOptions['filters'] | SaveFileOptions['filters'],
): Electron.FileFilter[] | undefined {
  if (!filters?.length) return undefined
  return filters.map((filter) => ({
    name: filter.name,
    extensions: [...filter.extensions],
  }))
}

export function createElectronFileService(): FileService {
  return {
    async pickFiles(options = {}) {
      const properties: Electron.OpenDialogOptions['properties'] = ['openFile']
      if (options.multiple) properties.push('multiSelections')
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        filters: fileFilters(options.filters),
        properties,
      }
      const owner = ownerWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? [] : result.filePaths
    },
    async pickDirectory(options = {}) {
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        properties: ['openDirectory'],
      }
      const owner = ownerWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    async saveFile(options = {}) {
      const dialogOptions: Electron.SaveDialogOptions = {
        title: options.title,
        defaultPath: options.suggestedName,
        filters: fileFilters(options.filters),
      }
      const owner = ownerWindow()
      const result = owner
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      return result.canceled ? null : (result.filePath ?? null)
    },
    async revealPath(targetPath: string) {
      shell.showItemInFolder(targetPath)
    },
  }
}

function diagnosticsDestination(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>).destination
  return typeof value === 'string' && value.trim() ? value : undefined
}

export interface ElectronClientAdapter {
  readonly commands: ClientCommandBus
  readonly lifecycle: AppLifecycleService
  readonly files: FileService
  readonly credentials: CredentialService
  readonly recovery: SessionRecoveryService
  readonly diagnostics: DiagnosticsService
  readonly network: NetworkService
  registerProtocol(): Promise<boolean>
  dispatchArgv(argv: readonly string[]): Promise<void>
  dispatchDeepLink(url: string): Promise<void>
  markReady(): Promise<void>
}

/**
 * Electron reference adapter for the shared v0.2 Client Core. Only commands
 * with real Electron behavior are registered. Recognized but not-yet-wired
 * commands are logged and safely fall back to focusing the current client.
 */
export function createElectronClientAdapter(): ElectronClientAdapter {
  const commands = new ClientCommandBus()
  const lifecycle = createElectronLifecycleService()
  const files = createElectronFileService()
  const credentials = createElectronCredentialService()
  const recovery = createElectronSessionRecoveryService()
  const network = createElectronNetworkService()
  const diagnostics = createElectronDiagnosticsService(network)
  const pendingUrls: string[] = []
  let pendingFocus = false
  let ready = false

  commands.register('app.focus', async () => lifecycle.focus())
  commands.register('app.quit', async () => lifecycle.quit())
  commands.register('app.relaunch', async () => lifecycle.relaunch())
  commands.register('diagnostics.export', async (command) => {
    const file = await diagnostics.exportBundle(diagnosticsDestination(command.payload))
    await bootLog(`diagnostics exported: ${file}`)
    return file
  })

  const dispatchReadyDeepLink = async (url: string): Promise<void> => {
    try {
      const intent = parseHarnessDockDeepLink(url)
      const command = deepLinkIntentToCommand(intent)
      try {
        await commands.dispatch({
          name: command.name,
          payload: command.payload,
          source: 'deep-link',
        })
      } catch (error) {
        if (!(error instanceof UnsupportedClientCommandError)) throw error
        await bootLog(`deep-link recognized but handler is not wired yet: ${command.name}`)
        await lifecycle.focus()
      }
    } catch (error) {
      await bootLog(
        `deep-link rejected: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const dispatchDeepLink = async (url: string): Promise<void> => {
    if (!ready) {
      pendingUrls.push(url)
      return
    }
    await dispatchReadyDeepLink(url)
  }

  const dispatchArgv = async (argv: readonly string[]): Promise<void> => {
    const urls = extractHarnessDockDeepLinks(argv)
    if (urls.length === 0) {
      if (ready) await lifecycle.focus()
      else pendingFocus = true
      return
    }
    for (const url of urls) await dispatchDeepLink(url)
  }

  return {
    commands,
    lifecycle,
    files,
    credentials,
    recovery,
    diagnostics,
    network,
    async registerProtocol() {
      if (!app.isPackaged) return false
      try {
        const registered = app.setAsDefaultProtocolClient('harnessdock')
        await bootLog(`deep-link protocol registration: ${registered ? 'ok' : 'not-default'}`)
        return registered
      } catch (error) {
        await bootLog(
          `deep-link protocol registration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      }
    },
    dispatchArgv,
    dispatchDeepLink,
    async markReady() {
      if (ready) return
      ready = true
      const queued = pendingUrls.splice(0)
      if (pendingFocus) {
        pendingFocus = false
        await lifecycle.focus()
      }
      for (const url of queued) await dispatchReadyDeepLink(url)
    },
  }
}
