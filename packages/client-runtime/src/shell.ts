/**
 * Windows .cmd/.bat spawn support.
 *
 * Node >= 20.12 (CVE-2024-27980 mitigation, applies to Electron >= 30 too)
 * throws `EINVAL` when child_process.spawn() is called with a `.cmd`/`.bat`
 * file unless `shell: true` is used. The packaged app resolves the runtime to
 * `npx.cmd` in download mode, so we route such commands through `cmd.exe`
 * explicitly with cmd-safe quoting instead of relying on `shell: true`
 * (which does not quote arguments for us).
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

/**
 * Wrap a Windows .cmd/.bat invocation so it can be spawned without `shell: true`.
 *
 * Non-script commands (and non-Windows platforms) are returned unchanged.
 */
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

/**
 * Quote a single token for a `cmd.exe /c` command line.
 *
 * Wraps the token in double quotes when it contains whitespace or cmd
 * metacharacters, doubling embedded quotes as cmd expects.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}
