export interface ConfigDumpRow {
  id: string
  name?: string
  source: string
  patchedBy: string[]
}

export type PluginRecoveryReason = 'diagnostic-match' | 'ambiguous'

export interface PluginRecoveryPlan {
  /** Complete external safety set isolated for the recovery boot. */
  isolationRows: ConfigDumpRow[]
  /** Rows directly named by the startup diagnostic, for observability only. */
  suspectedRows: ConfigDumpRow[]
  reason: PluginRecoveryReason
}

const HOST_OWNED_PLUGIN_IDS = new Set([
  'embedded-client',
  'harnessdock-client-runtime-compat',
  'harness-shell',
])

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

function isOfficialPluginRow(row: Pick<ConfigDumpRow, 'source' | 'name'>): boolean {
  if (isOfficialDshSource(row.source)) return true
  const name = row.name ?? ''
  return isOfficialDshSource(name)
}

export function pluginRecoveryCandidates(rows: readonly ConfigDumpRow[]): ConfigDumpRow[] {
  return rows.filter(
    (row) =>
      !HOST_OWNED_PLUGIN_IDS.has(row.id) &&
      row.source !== '' &&
      !isOfficialPluginRow(row),
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
 * Build a bounded, session-safe recovery plan after a normal startup failure.
 *
 * A dsh/Cordis startup diagnostic commonly identifies only the first stale
 * plugin. Narrowly disabling only that row lets a second incompatible plugin
 * fail the recovery boot and still keep the service offline. Therefore the
 * actual recovery isolation set is always the complete third-party/user-added
 * set. Diagnostic matches are retained separately as `suspectedRows` so the UI
 * and quarantine layer can explain what most likely caused the failure without
 * weakening the safety set.
 */
export function buildPluginRecoveryPlan(
  rows: readonly ConfigDumpRow[],
  diagnostic: string,
): PluginRecoveryPlan {
  const isolationRows = pluginRecoveryCandidates(rows)
  const suspectedRows = isolationRows.filter((row) => diagnosticMatches(row, diagnostic))
  return {
    isolationRows,
    suspectedRows,
    reason: suspectedRows.length > 0 ? 'diagnostic-match' : 'ambiguous',
  }
}

/** Backwards-compatible helper used by existing callers. */
export function selectPluginRecoveryRows(
  rows: readonly ConfigDumpRow[],
  diagnostic: string,
): ConfigDumpRow[] {
  return buildPluginRecoveryPlan(rows, diagnostic).isolationRows
}

export function renderPluginRecoveryPatch(rows: readonly Pick<ConfigDumpRow, 'id'>[]): string {
  const unique = [...new Set(rows.map((row) => row.id).filter(Boolean))]
  return unique.map((id) => `- id: ${JSON.stringify(id)}\n  disabled: true\n`).join('')
}
