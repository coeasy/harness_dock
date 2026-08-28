export function buildLaunchArgs(input: { patchFile: string }): string[] {
  // `--patch` is a top-level dsh option; the `web` subcommand itself rejects it
  // (`web takes none of parent --patch`), so boot via `--profile web` instead.
  return [
    '--profile',
    'web',
    '--patch',
    input.patchFile,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ]
}

export function renderEmbeddedPatch(pluginAbsolutePath: string): string {
  // Windows 绝对路径在插件加载时会被当作 'd:' 协议，必须输出 file:// URL 形式
  const posix = pluginAbsolutePath.replace(/\\/g, '/')
  return `- insert:\n    - id: embedded-client\n      name: 'file:///${posix}'\n`
}
