import { inspectBundledModules, inspectBundledRuntime } from './bundled.ts'
import { rejectFloatingDistTag } from '@dsh/docs-sync'
import type { RuntimeMode } from './types.ts'

export interface ResolvedCommand {
  command: string
  argsPrefix: string[]
  /** extra environment variables required by this command (e.g. ELECTRON_RUN_AS_NODE) */
  extraEnv?: Record<string, string>
}

export function npxCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (env.NPX_BIN) return env.NPX_BIN
  return platform === 'win32' ? 'npx.cmd' : 'npx'
}

export async function resolveDshCommand(input: {
  mode: RuntimeMode
  version: string
  env: NodeJS.ProcessEnv
  bundledRoot?: string
  platform?: NodeJS.Platform
  which?: (cmd: string) => Promise<string | null>
  execPath?: string
}): Promise<ResolvedCommand> {
  const version = rejectFloatingDistTag(input.version)
  const platform = input.platform ?? process.platform
  const which = input.which ?? defaultWhich

  if (input.mode === 'local') {
    const fromEnv = input.env.DSH_BIN
    if (fromEnv) return { command: fromEnv, argsPrefix: [] }
    const found = await which('dsh')
    if (!found) {
      throw new Error(
        'DSH_RUNTIME=local but dsh is not on PATH. Install @deepseek-ai/dsh at the origin version, or set DSH_BIN.',
      )
    }
    return { command: found, argsPrefix: [] }
  }

  if (input.mode === 'bundled') {
    const root = input.bundledRoot
    if (!root) throw new Error('bundled runtime requested but bundledRoot is missing')
    const layout = inspectBundledRuntime(root, platform)
    if (layout) {
      return layout.usesElectronNode
        ? {
            command: input.execPath ?? layout.nodeBin,
            argsPrefix: [layout.dshBin],
            extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
          }
        : { command: layout.nodeBin, argsPrefix: [layout.dshBin] }
    }

    // Unit tests and non-Electron hosts can still resolve an explicitly supplied
    // module seed when an execPath is provided.
    const modules = inspectBundledModules(root)
    if (!modules || !input.execPath) {
      throw new Error(
        `bundled runtime is incomplete under ${root}. Expected node_modules/@deepseek-ai/dsh/lib/bin.js`,
      )
    }
    return {
      command: input.execPath,
      argsPrefix: [modules.dshBin],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }

  return {
    command: npxCommand(platform, input.env),
    argsPrefix: ['--yes', `@deepseek-ai/dsh@${version}`],
  }
}

async function defaultWhich(cmd: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const tool = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(tool, [cmd], { windowsHide: true })
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    return first ?? null
  } catch {
    return null
  }
}
