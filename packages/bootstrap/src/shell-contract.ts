/**
 * Versioned contract between a host shell and the Harness Web surface.
 *
 * The web app only knows this small bridge. Native hosts are free to map the
 * commands to Tauri or another dsh host without leaking native implementation
 * details into the Harness Web page.
 */
export const SHELL_API_VERSION = 1 as const

export type ShellCommandName =
  | 'window.minimize'
  | 'window.toggleMaximize'
  | 'window.state'
  | 'window.close'
  | 'web.reload'
  | 'web.restart'
  | 'runtime.safe-mode'
  | 'runtime.clear-quarantine'
  | 'gateway.manage'
  | 'diagnostics.open'
  | 'app.update.check'
  | 'app.update.install'
  | 'app.quit'

export const SHELL_COMMANDS: readonly ShellCommandName[] = [
  'window.minimize',
  'window.toggleMaximize',
  'window.state',
  'window.close',
  'web.reload',
  'web.restart',
  'runtime.safe-mode',
  'runtime.clear-quarantine',
  'gateway.manage',
  'diagnostics.open',
  'app.update.check',
  'app.update.install',
  'app.quit',
]

export type ShellCapabilities = Readonly<Partial<Record<ShellCommandName, boolean>>>

export interface ShellStatusEvent {
  state: 'starting' | 'ready' | 'busy' | 'degraded' | 'error'
  message?: string
  runtimeVersion?: string
  isolated?: boolean
}

export interface ShellBridge {
  apiVersion: typeof SHELL_API_VERSION
  pluginId: 'harness-shell'
  version: '0.2.0'
  capabilities: ShellCapabilities
  invoke<TResult = unknown>(command: ShellCommandName, payload?: unknown): Promise<TResult>
  subscribe?(listener: (event: ShellStatusEvent) => void): () => void
}

export function isShellCommandName(value: unknown): value is ShellCommandName {
  return typeof value === 'string' && (SHELL_COMMANDS as readonly string[]).includes(value)
}

export function normalizeShellCapabilities(
  capabilities: ShellCapabilities | undefined,
): Record<ShellCommandName, boolean> {
  return Object.fromEntries(
    SHELL_COMMANDS.map((command) => [command, capabilities?.[command] !== false]),
  ) as Record<ShellCommandName, boolean>
}

export function assertShellBridgeVersion(apiVersion: unknown): asserts apiVersion is 1 {
  if (apiVersion !== SHELL_API_VERSION) {
    throw new Error(
      `Unsupported Harness shell API version: ${String(apiVersion)} (expected ${SHELL_API_VERSION})`,
    )
  }
}
