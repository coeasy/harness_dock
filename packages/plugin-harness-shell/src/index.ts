import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'harness-shell'
export const inject: readonly string[] = []
export const version = '0.2.0' as const
export const apiVersion = 1 as const

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
  capabilities: [
    'window.minimize',
    'window.toggleMaximize',
    'window.state',
    'window.close',
    'web.reload',
    'web.restart',
    'runtime.safe-mode',
    'runtime.clear-quarantine',
    'diagnostics.open',
    'app.update.check',
    'app.update.install',
    'app.quit',
  ],
}

/**
 * dsh plugin entrypoint. It is deliberately feature-detected so older dsh
 * hosts can install it without making the Harness Web startup path fragile.
 */
export function apply(ctx: PluginContext = {}): void {
  const register = ctx.provide ?? ctx.set
  register?.('harnessShell', service)

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
