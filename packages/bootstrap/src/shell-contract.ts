/**
 * Versioned contract between a host shell and the Harness Web surface.
 *
 * The web app only knows this small bridge. Native hosts are free to map the
 * commands to Tauri or another dsh host without leaking native implementation
 * details into the Harness Web page.
 *
 * v2: the desktop shell bridge (`harness_shell.rs` BRIDGE_SCRIPT) publishes
 * `apiVersion: 2`. Keep this constant in lockstep with that injection script —
 * the `check:shell-package` gate asserts the two never drift.
 */
export const SHELL_API_VERSION = 2 as const

export type ShellCommandName =
  | 'window.minimize'
  | 'window.toggleMaximize'
  | 'window.state'
  | 'window.close'
  | 'web.reload'
  | 'web.restart'
  | 'runtime.safe-mode'
  | 'gateway.manage'
  | 'diagnostics.open'

/**
 * The **web-reachable** command set. A name belongs here only if
 * `capability_broker.rs` grants it to the `HarnessWeb` subject; everything the
 * broker denies to web is reachable from the native tray / diagnostics
 * surfaces and must stay out of this list.
 *
 * Three invariants, all enforced by
 * `tests/parity/shell-contract-lockstep.test.ts`:
 *
 * 1. It is wired into the desktop shell bridge (`directWindowMap` /
 *    `hostCommandMap` in `harness_shell.rs`) — a declared-but-unwired name is
 *    an orphan the web surface would `await` forever.
 * 2. Its capability is in the broker's HarnessWeb allow branch.
 * 3. If routed through host protocol v2, its wire name exists in
 *    `protocol/host-protocol-v2.json`.
 *
 * Removed as web-unreachable: `runtime.clear-quarantine`,
 * `app.update.check`, `app.update.install` and `app.quit` — the broker denies
 * `RuntimeQuarantineAdmin`, `UpdateCheck`, `UpdateInstall` and `AppQuit` to
 * the HarnessWeb subject, so advertising them here would let a page call a
 * command the host is guaranteed to reject.
 */
export const SHELL_COMMANDS: readonly ShellCommandName[] = [
  'window.minimize',
  'window.toggleMaximize',
  'window.state',
  'window.close',
  'web.reload',
  'web.restart',
  'runtime.safe-mode',
  'gateway.manage',
  'diagnostics.open',
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
  // Deny-by-default: a capability is enabled only when the host explicitly
  // declared `true`. Missing declarations must not silently grant authority
  // to the remote Harness document.
  return Object.fromEntries(
    SHELL_COMMANDS.map((command) => [command, capabilities?.[command] === true]),
  ) as Record<ShellCommandName, boolean>
}

export function assertShellBridgeVersion(apiVersion: unknown): asserts apiVersion is 2 {
  if (apiVersion !== SHELL_API_VERSION) {
    throw new Error(
      `Unsupported Harness shell API version: ${String(apiVersion)} (expected ${SHELL_API_VERSION})`,
    )
  }
}
