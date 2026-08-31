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

export function renderEmbeddedPatch(pluginAbsolutePath: string, compatibilityAbsolutePath?: string): string {
  // The include loader imports the entry as a URL. Windows paths must be
  // percent-encoded (especially spaces in the default Program Files install
  // directory), otherwise Node parses the URL but cannot import the module.
  const pluginUrl = toFileUrl(pluginAbsolutePath).replaceAll("'", "''")
  const compatibility = compatibilityAbsolutePath
    ? `    - id: harnessdock-client-runtime-compat\n      name: '${toFileUrl(compatibilityAbsolutePath).replaceAll("'", "''")}'\n`
    : ''
  return `- insert:\n    - id: embedded-client\n      name: '${pluginUrl}'\n${compatibility}`
}

function toFileUrl(filePath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    const normalized = filePath.replaceAll('\\', '/')
    const segments = normalized.split('/')
    const encoded = segments
      .map((segment, index) =>
        index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
      )
      .join('/')
    return `file:///${encoded}`
  }
  return pathToFileURL(filePath).href
}
