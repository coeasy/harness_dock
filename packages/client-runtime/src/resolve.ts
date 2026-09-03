import { inspectBundledRuntime } from './bundled.ts'
import { rejectFloatingDistTag } from '@dsh/docs-sync'
import type { RuntimeMode } from './types.ts'

export interface ResolvedCommand {
  command: string
  argsPrefix: string[]
  /** extra environment variables required by this command */
  extraEnv?: Record<string, string>
}

/** Matches the dsh package engine range: ^22.19.0 || >=24.0.0. */
export function isSupportedNodeVersion(raw: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
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
  probeNode?: (nodePath: string) => Promise<string | null>
}): Promise<ResolvedCommand> {
  const version = rejectFloatingDistTag(input.version)
  const platform = input.platform ?? process.platform
  const which = input.which ?? ((cmd) => defaultWhich(cmd, platform))

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
    if (!layout) {
      throw new Error(
        `bundled runtime is incomplete under ${root}. Expected vendored node plus node_modules/@deepseek-ai/dsh/lib/bin.js`,
      )
    }
    const systemNode = input.env.HARNESSDOCK_USE_SYSTEM_NODE === '0'
      ? null
      : await findUsableSystemNode({
          platform,
          which,
          probeNode: input.probeNode ?? defaultNodeVersion,
        })
    return { command: systemNode ?? layout.nodeBin, argsPrefix: [layout.dshBin] }
  }

  return {
    command: npxCommand(platform, input.env),
    argsPrefix: ['--yes', `@deepseek-ai/dsh@${version}`],
  }
}

export async function findUsableSystemNode(input: {
  platform: NodeJS.Platform
  which: (cmd: string) => Promise<string | null>
  probeNode: (nodePath: string) => Promise<string | null>
}): Promise<string | null> {
  const found = await input.which('node')
  if (!found) return null
  const version = await input.probeNode(found)
  return version !== null && isSupportedNodeVersion(version) ? found : null
}

async function defaultWhich(cmd: string, platform: NodeJS.Platform): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const tool = platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(tool, [cmd], { windowsHide: true })
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    return first ?? null
  } catch {
    return null
  }
}

async function defaultNodeVersion(nodePath: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  try {
    const { stdout } = await execFileAsync(nodePath, ['--version'], { windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}
