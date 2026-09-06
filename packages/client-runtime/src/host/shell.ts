/**
 * Windows .cmd/.bat spawn support.
 *
 * Node >= 20.12 (CVE-2024-27980 mitigation) rejects spawning a batch script
 * directly unless a shell is involved. Route those commands through cmd.exe
 * explicitly with cmd-safe quoting instead of enabling `shell: true`.
 */

const WINDOWS_SCRIPT = /\.(cmd|bat)$/i

export function isWindowsScriptCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && WINDOWS_SCRIPT.test(command.trim())
}

export interface SpawnRequest {
  command: string
  args: string[]
}

export function buildSpawnRequest(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnRequest {
  if (!isWindowsScriptCommand(command, platform)) {
    return { command, args }
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
  }
}

/** Quote one token for a `cmd.exe /c` command line. */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}
