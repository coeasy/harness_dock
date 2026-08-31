export interface ConfigDumpRow {
  id: string
  name?: string
  source: string
  patchedBy: string[]
}

function decodeYamlScalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function parseSourceLabel(line: string): { source: string; patchedBy: string[] } | null {
  if (!line.startsWith('# == ')) return null
  const raw = line.slice('# == '.length).trim()
  const marker = ', patched by '
  const markerIndex = raw.indexOf(marker)
  if (markerIndex < 0) return { source: raw, patchedBy: [] }
  const source = raw.slice(0, markerIndex).trim()
  const patchedBy = raw
    .slice(markerIndex + marker.length)
    .split(', ')
    .map((value) => value.trim())
    .filter(Boolean)
  return { source, patchedBy }
}

/**
 * Parse the boot-free `dsh --dump-config` output without evaluating any plugin.
 * The dump annotates each effective top-level row with `# == <origin>` comments,
 * which lets the host distinguish official bundle rows from user/third-party rows.
 */
export function parseConfigDumpRows(dump: string): ConfigDumpRow[] {
  const rows: ConfigDumpRow[] = []
  let source = ''
  let patchedBy: string[] = []
  let current: ConfigDumpRow | undefined

  const finish = () => {
    if (!current) return
    rows.push(current)
    current = undefined
  }

  for (const line of dump.split(/\r?\n/)) {
    const label = parseSourceLabel(line)
    if (label) {
      finish()
      source = label.source
      patchedBy = label.patchedBy
      continue
    }
    const idMatch = /^- id:\s*(.+?)\s*$/.exec(line)
    if (idMatch?.[1]) {
      finish()
      current = {
        id: decodeYamlScalar(idMatch[1]),
        source,
        patchedBy: [...patchedBy],
      }
      continue
    }
    const nameMatch = /^  name:\s*(.+?)\s*$/.exec(line)
    if (current && nameMatch?.[1]) {
      current.name = decodeYamlScalar(nameMatch[1])
    }
  }
  finish()
  return rows
}

export function isOfficialDshSource(source: string): boolean {
  const normalized = source.replaceAll('\\', '/')
  return source.startsWith('@deepseek-ai/') || normalized.includes('/node_modules/@deepseek-ai/')
}

export function pluginRecoveryCandidates(rows: readonly ConfigDumpRow[]): ConfigDumpRow[] {
  return rows.filter(
    (row) =>
      row.id !== 'embedded-client' &&
      row.source !== '' &&
      !isOfficialDshSource(row.source),
  )
}

function basename(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function diagnosticMatches(row: ConfigDumpRow, diagnostic: string): boolean {
  const haystack = diagnostic.toLowerCase()
  const tokens = [row.id, row.name ?? '', row.source, basename(row.name ?? ''), basename(row.source)]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3)
  return tokens.some((token) => haystack.includes(token))
}

/**
 * Prefer rows actually named by the startup error. If the upstream error does
 * not identify a row reliably, recover conservatively by disabling only rows
 * whose origin is outside the official @deepseek-ai bundles. Official rows and
 * HarnessDock's own embedded bridge are never part of this fallback set.
 */
export function selectPluginRecoveryRows(
  rows: readonly ConfigDumpRow[],
  diagnostic: string,
): ConfigDumpRow[] {
  const candidates = pluginRecoveryCandidates(rows)
  const matched = candidates.filter((row) => diagnosticMatches(row, diagnostic))
  return matched.length > 0 ? matched : candidates
}

export function renderPluginRecoveryPatch(rows: readonly Pick<ConfigDumpRow, 'id'>[]): string {
  const unique = [...new Set(rows.map((row) => row.id).filter(Boolean))]
  return unique.map((id) => `- id: ${JSON.stringify(id)}\n  disabled: true\n`).join('')
}
