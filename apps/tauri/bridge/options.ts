export interface TauriRuntimeBridgeOptions {
  originPath: string
  pluginPath: string
  userDataDir: string
  stateFile: string
  shutdownFile: string
  packaged: boolean
  bundledRoot?: string
}

function parseBoolean(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

function parseArgMap(argv: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const equals = token.indexOf('=')
    if (equals > 2) {
      result.set(token.slice(2, equals), token.slice(equals + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      result.set(key, next)
      index += 1
    } else {
      result.set(key, 'true')
    }
  }
  return result
}

function requireArg(args: Map<string, string>, key: string): string {
  const value = args.get(key)?.trim()
  if (!value) throw new Error(`Missing required --${key} argument.`)
  return value
}

export function parseTauriRuntimeBridgeOptions(
  argv: readonly string[] = process.argv.slice(2),
): TauriRuntimeBridgeOptions {
  const args = parseArgMap(argv)
  const bundledRoot = args.get('bundled-root')?.trim()
  return {
    originPath: requireArg(args, 'origin'),
    pluginPath: requireArg(args, 'plugin'),
    userDataDir: requireArg(args, 'user-data'),
    stateFile: requireArg(args, 'state-file'),
    shutdownFile: requireArg(args, 'shutdown-file'),
    packaged: parseBoolean(args.get('packaged')),
    ...(bundledRoot ? { bundledRoot } : {}),
  }
}
