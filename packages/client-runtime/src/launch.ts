import { pathToFileURL } from 'node:url'

export function buildLaunchArgs(input: { patchFile: string }): string[] {
  // --patch is a top-level dsh option; the web subcommand itself rejects it
  // (web takes none of parent --patch), so boot via --profile web instead.
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
  // The include loader imports the entry as a URL. Windows paths must be
  // percent-encoded (especially spaces in the default Program Files install
  // directory), otherwise Node parses the URL but cannot import the module.
  const pluginUrl = pathToFileURL(pluginAbsolutePath).href.replaceAll("'", "''")
  return `- insert:\n    - id: embedded-client\n      name: '${pluginUrl}'\n`
}
