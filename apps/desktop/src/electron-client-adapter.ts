import { app, Notification, type BrowserWindow } from 'electron'
import {
  ClientCommandBus,
  ClientPolicyDeniedError,
  UnsupportedClientCommandError,
  deepLinkIntentToCommand,
  parseHarnessDockDeepLink,
  type AppLifecycleService,
  type ClientCommandEnvelope,
  type ClientCommandName,
  type ClientServiceContract,
  type CredentialService,
  type DeepLinkService,
  type DiagnosticsService,
  type FileService,
  type LogService,
  type NetworkService,
  type NotificationService,
  type PolicyService,
  type RuntimeService,
  type SessionRecoveryService,
  type UpdateService,
  type UpdateTarget,
  type WindowService,
} from '@dsh/bootstrap/client-core'
import { ELECTRON_HOST_PROFILE } from '@dsh/bootstrap'
import { bootLog } from './boot-log.ts'
import { extractHarnessDockDeepLinks } from './client-activation.ts'
import { createElectronFileService } from './electron-file-service.ts'
import {
  createElectronCredentialService,
  createElectronDiagnosticsService,
  createElectronLogService,
  createElectronNetworkService,
  createElectronSessionRecoveryService,
} from './electron-services.ts'
import { createElectronRuntimeService } from './runtime-controller.ts'
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
      app.quit()
    },
  }
}

function diagnosticsDestination(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>).destination
  return typeof value === 'string' && value.trim() ? value : undefined
}

function updateTarget(payload: unknown): UpdateTarget {
  if (!payload || typeof payload !== 'object') return 'host'
  const target = (payload as Record<string, unknown>).target
  if (target === undefined) return 'host'
  if (target === 'host' || target === 'runtime') return target
  throw new Error(`Unsupported desktop update target: ${String(target)}`)
}

function requireUpdateService(): UpdateService {
  const service = appState.updates ?? appState.hostUpdate
  if (!service) throw new Error('Update service is not initialized yet')
  return service
}

function createLazyUpdateService(): UpdateService {
  return {
    state: (target) => requireUpdateService().state(target),
    check: (target) => requireUpdateService().check(target),
    download: (target) => requireUpdateService().download(target),
    install: (target) => requireUpdateService().install(target),
    rollback: (target) => requireUpdateService().rollback(target),
  }
}

function createElectronNotificationService(): NotificationService {
  return {
    async notify(input) {
      if (!Notification.isSupported()) return
      new Notification({ title: input.title, body: input.body, silent: input.silent }).show()
    },
  }
}

function createElectronWindowService(): WindowService {
  return {
    async focusMain() {
      focusElectronMainWindow()
    },
    async showMain() {
      const window = ownerWindow()
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
    },
    async hideMain() {
      ownerWindow()?.hide()
    },
    async state() {
      const window = ownerWindow()
      return {
        visible: Boolean(window?.isVisible()),
        focused: Boolean(window?.isFocused()),
        minimized: Boolean(window?.isMinimized()),
        maximized: Boolean(window?.isMaximized()),
        fullscreen: Boolean(window?.isFullScreen()),
      }
    },
  }
}

function createElectronPolicyService(): PolicyService {
  const deepLinkDenied = new Set<ClientCommandName>(['plugin.install', 'mcp.install', 'update.install'])
  const evaluate: PolicyService['evaluate'] = async (request) => {
    if (request.source === 'deep-link' && deepLinkDenied.has(request.action as ClientCommandName)) {
      return { allowed: false, reason: 'deep links cannot bypass confirmation/trust gates' }
    }
    if (request.capability) {
      const capabilities = ELECTRON_HOST_PROFILE.capabilities as unknown as Record<string, unknown>
      if (capabilities[request.capability] === false) {
        return { allowed: false, reason: `host capability ${request.capability} is unavailable` }
      }
    }
    return { allowed: true }
  }
  return {
    evaluate,
    async assertAllowed(request) {
      const decision = await evaluate(request)
      if (!decision.allowed) throw new ClientPolicyDeniedError(request.action, decision.reason)
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasString(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'string' && Boolean((value[key] as string).trim())
}

async function navigateMain(route: string): Promise<void> {
  const window = ownerWindow()
  if (!window) return
  const current = window.webContents.getURL() || appState.runtimeEndpoint
  if (!current) return
  const origin = new URL(current).origin
  const target = new URL(route, `${origin}/`)
  if (target.origin !== origin) throw new Error('Client navigation escaped the local runtime origin')
  await window.loadURL(target.toString())
  focusElectronMainWindow()
}

export interface ElectronClientAdapter {
  readonly commands: ClientCommandBus
  readonly lifecycle: AppLifecycleService
  readonly runtime: RuntimeService
  readonly files: FileService
  readonly credentials: CredentialService
  readonly updates: UpdateService
  readonly recovery: SessionRecoveryService
  readonly diagnostics: DiagnosticsService
  readonly network: NetworkService
  readonly logs: LogService
  readonly notifications: NotificationService
  readonly deepLinks: DeepLinkService
  readonly windows: WindowService
  readonly policy: PolicyService
  readonly services: ClientServiceContract
  registerProtocol(): Promise<boolean>
  dispatchArgv(argv: readonly string[]): Promise<void>
  dispatchDeepLink(url: string): Promise<void>
  markReady(): Promise<void>
}

export function createElectronClientAdapter(): ElectronClientAdapter {
  const commands = new ClientCommandBus()
  const lifecycle = createElectronLifecycleService()
  const runtime = createElectronRuntimeService()
  const files = createElectronFileService()
  const credentials = createElectronCredentialService()
  const updates = createLazyUpdateService()
  const recovery = createElectronSessionRecoveryService()
  const network = createElectronNetworkService(credentials)
  const logs = createElectronLogService()
  const diagnostics = createElectronDiagnosticsService(network, logs)
  const notifications = createElectronNotificationService()
  const windows = createElectronWindowService()
  const policy = createElectronPolicyService()
  const deepLinkListeners = new Set<(url: string) => void>()
  const pendingUrls: string[] = []
  let pendingFocus = false
  let ready = false

  const registerProtocolImpl = async (): Promise<boolean> => {
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
  }

  const deepLinks: DeepLinkService = {
    async register(protocol) {
      if (protocol !== 'harnessdock') throw new Error(`Unsupported deep-link protocol: ${protocol}`)
      await registerProtocolImpl()
    },
    subscribe(listener) {
      deepLinkListeners.add(listener)
      return () => deepLinkListeners.delete(listener)
    },
  }

  const authorize = async (command: ClientCommandEnvelope): Promise<void> => {
    await policy.assertAllowed({ action: command.name, source: command.source })
  }

  commands.register('app.focus', async (command) => {
    await authorize(command)
    if (isRecord(command.payload) && typeof command.payload.route === 'string') {
      await navigateMain(command.payload.route)
      return
    }
    await lifecycle.focus()
  })
  commands.register('app.quit', async (command) => { await authorize(command); await lifecycle.quit() })
  commands.register('app.relaunch', async (command) => { await authorize(command); await lifecycle.relaunch() })
  commands.register('runtime.restart', async (command) => { await authorize(command); return runtime.restart() }, { timeoutMs: 30_000 })
  commands.register('runtime.stop', async (command) => { await authorize(command); return runtime.stop() }, { timeoutMs: 30_000 })
  commands.register('update.check', async (command) => {
    await authorize(command)
    return updates.check(updateTarget(command.payload))
  })
  commands.register('update.install', async (command) => {
    await authorize(command)
    const target = updateTarget(command.payload)
    const state = await updates.state(target)
    if (state.phase === 'available') await updates.download(target)
    return updates.install(target)
  }, { timeoutMs: 120_000 })
  commands.register('session.open', async (command) => {
    await authorize(command)
    if (!hasString(command.payload, 'sessionId')) throw new Error('session.open requires sessionId')
    await navigateMain(`/session/${encodeURIComponent((command.payload as Record<string, string>).sessionId)}`)
  }, { validate: (payload) => hasString(payload, 'sessionId') })
  commands.register('workspace.open', async (command) => {
    await authorize(command)
    if (hasString(command.payload, 'workspaceId')) {
      await navigateMain(`/workspace/${encodeURIComponent((command.payload as Record<string, string>).workspaceId)}`)
      return
    }
    if (hasString(command.payload, 'path')) {
      const value = (command.payload as Record<string, string>).path
      await navigateMain(`/workspace/open?path=${encodeURIComponent(value)}`)
      return
    }
    throw new Error('workspace.open requires workspaceId or path')
  }, { validate: (payload) => hasString(payload, 'workspaceId') || hasString(payload, 'path') })
  commands.register('plugin.install', async (command) => {
    await authorize(command)
    await logs.write({
      level: 'info', component: 'command-bus', event: 'plugin_install_requires_trust_flow',
      data: { pluginId: isRecord(command.payload) ? command.payload.pluginId : undefined },
    })
    await lifecycle.focus()
    return { requiresConfirmation: true }
  }, { validate: (payload) => hasString(payload, 'pluginId') })
  commands.register('mcp.install', async (command) => {
    await authorize(command)
    await logs.write({
      level: 'info', component: 'command-bus', event: 'mcp_install_requires_trust_flow',
      data: { serverId: isRecord(command.payload) ? command.payload.serverId : undefined },
    })
    await lifecycle.focus()
    return { requiresConfirmation: true }
  }, { validate: (payload) => hasString(payload, 'serverId') })
  commands.register('device.pair', async (command) => {
    await authorize(command)
    if (!hasString(command.payload, 'token')) throw new Error('device.pair requires token')
    await logs.write({ level: 'info', component: 'gateway', event: 'pairing_deep_link_received' })
    await lifecycle.focus()
  }, { validate: (payload) => hasString(payload, 'token') })
  commands.register('auth.callback', async (command) => {
    await authorize(command)
    if (!hasString(command.payload, 'state')) throw new Error('auth.callback requires state')
    const payload = command.payload as Record<string, string | undefined>
    const key = `oauth.pending.${payload.state}`
    const returnRoute = await credentials.get(key)
    if (!returnRoute) throw new ClientPolicyDeniedError('auth.callback', 'unknown, expired or already-used OAuth state')
    await credentials.delete(key)
    await logs.write({
      level: payload.error ? 'warn' : 'info',
      component: 'security',
      event: payload.error ? 'oauth_callback_error' : 'oauth_callback_verified',
      data: { provider: payload.provider, error: payload.error },
    })
    if (returnRoute.startsWith('/')) await navigateMain(returnRoute)
    else await lifecycle.focus()
  }, { validate: (payload) => hasString(payload, 'state') && isRecord(payload) && (hasString(payload, 'code') !== hasString(payload, 'error')) })
  commands.register('diagnostics.export', async (command) => {
    await authorize(command)
    const file = await diagnostics.exportBundle(diagnosticsDestination(command.payload))
    await logs.write({ level: 'info', component: 'diagnostics', event: 'exported', data: { file } })
    return file
  })

  const dispatchReadyDeepLink = async (url: string): Promise<void> => {
    try {
      const intent = parseHarnessDockDeepLink(url)
      const command = deepLinkIntentToCommand(intent)
      for (const listener of deepLinkListeners) listener(url)
      try {
        await commands.dispatch({ name: command.name, payload: command.payload, source: 'deep-link' })
      } catch (error) {
        if (!(error instanceof UnsupportedClientCommandError) && !(error instanceof ClientPolicyDeniedError)) throw error
        await bootLog(`deep-link recognized but blocked/not wired: ${command.name}: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.focus()
      }
    } catch (error) {
      await bootLog(`deep-link rejected: ${error instanceof Error ? error.message : String(error)}`)
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

  appState.networkUnsubscribe?.()
  appState.networkUnsubscribe = network.subscribe((state) => {
    void logs.write({ level: state === 'online' ? 'info' : 'warn', component: 'network', event: 'state_changed', data: { state } })
    if (state === 'online') {
      void runtime.health().then((health) => {
        if (health.ok) {
          void ownerWindow()?.webContents.executeJavaScript('window.dispatchEvent(new Event("online"))', true).catch(() => undefined)
        }
      }).catch(() => undefined)
    }
  })

  const services: ClientServiceContract = {
    app: lifecycle,
    runtime,
    files,
    credentials,
    updates,
    recovery,
    diagnostics,
    network,
    logs,
    notifications,
    deepLinks,
    windows,
    policy,
  }

  return {
    commands,
    lifecycle,
    runtime,
    files,
    credentials,
    updates,
    recovery,
    diagnostics,
    network,
    logs,
    notifications,
    deepLinks,
    windows,
    policy,
    services,
    registerProtocol: registerProtocolImpl,
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
