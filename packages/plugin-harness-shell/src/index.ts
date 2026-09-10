import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'harness-shell'
export const inject: readonly string[] = []
export const version = '0.1.5' as const
/**
 * Must match `SHELL_API_VERSION` in `packages/bootstrap/src/shell-contract.ts`
 * and the `apiVersion` published by the desktop bridge in `harness_shell.rs`.
 * `scripts/check-shell-package.mjs` asserts all three stay in lockstep.
 */
export const apiVersion = 2 as const

export interface HarnessShellService {
  pluginId: typeof name
  version: typeof version
  apiVersion: typeof apiVersion
  webEntry: string
  capabilities: readonly string[]
}

interface PluginContext {
  provide?: (key: string, value: HarnessShellService) => void
  set?: (key: string, value: HarnessShellService) => void
}

export const service: HarnessShellService = {
  pluginId: name,
  version,
  apiVersion,
  webEntry: fileURLToPath(new URL('../web/shell.js', import.meta.url)),
  // Must stay identical to SHELL_COMMANDS: this is the web-reachable set, so
  // anything `capability_broker.rs` denies to the HarnessWeb subject is absent.
  capabilities: [
    'window.minimize',
    'window.toggleMaximize',
    'window.state',
    'window.close',
    'web.reload',
    'web.restart',
    'runtime.safe-mode',
    'gateway.manage',
    'diagnostics.open',
  ],
}

/**
 * dsh plugin entrypoint. The shell is an optional enhancement to Harness Web,
 * never a Runtime boot dependency. Older or alternate hosts may expose a
 * provide/set hook with different lifecycle rules, so even a host-side
 * registration error must fail open and leave the official Harness Web usable.
 */
export function apply(ctx: PluginContext = {}): void {
  const register = ctx.provide ?? ctx.set
  try {
    register?.('harnessShell', service)
  } catch {
    // Do not let an optional shell-service registration failure abort dsh boot.
  }

  const readyFile = process.env.DSH_SHELL_PLUGIN_READY_FILE
  if (!readyFile) return
  try {
    writeFileSync(
      readyFile,
      `${JSON.stringify({ pluginId: name, version, apiVersion, pid: process.pid })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  } catch {
    // Startup must continue even when the optional readiness marker cannot be written.
  }
}

