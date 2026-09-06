import {
  SHELL_API_VERSION,
  SHELL_COMMANDS,
  SHELL_PLUGIN_ID,
  SHELL_VERSION,
} from './shell-contract.generated.ts'

export { SHELL_API_VERSION, SHELL_COMMANDS, SHELL_PLUGIN_ID, SHELL_VERSION }
export type ShellCommandName = (typeof SHELL_COMMANDS)[number]

/**
 * Versioned contract between a host shell and the Harness Web surface.
 *
 * The canonical command/version data lives in `protocol/shell-contract.json`
 * and is generated into this package. Native hosts are free to map those
 * commands to their own implementation without duplicating the public wire
 * contract.
 */
export type ShellCapabilities = Readonly<Partial<Record<ShellCommandName, boolean>>>

export interface ShellStatusEvent {
  state: 'starting' | 'ready' | 'busy' | 'degraded' | 'error'
  message?: string
  runtimeVersion?: string
  isolated?: boolean
}

export interface ShellBridge {
  apiVersion: typeof SHELL_API_VERSION
  pluginId: typeof SHELL_PLUGIN_ID
  version: typeof SHELL_VERSION
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
    SHELL_COMMANDS.map((command) => [command, capabilities?.[command] === true]),
  ) as Record<ShellCommandName, boolean>
}

export function assertShellBridgeVersion(
  apiVersion: unknown,
): asserts apiVersion is typeof SHELL_API_VERSION {
  if (apiVersion !== SHELL_API_VERSION) {
    throw new Error(
      `Unsupported Harness shell API version: ${String(apiVersion)} (expected ${SHELL_API_VERSION})`,
    )
  }
}
