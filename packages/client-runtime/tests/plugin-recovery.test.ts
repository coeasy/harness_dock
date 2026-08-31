import { describe, expect, it } from 'vitest'
import {
  buildPluginRecoveryPlan,
  isOfficialDshSource,
  parseConfigDumpRows,
  pluginRecoveryCandidates,
  renderPluginRecoveryPatch,
  selectPluginRecoveryRows,
} from '../src/plugin-recovery.ts'

const dump = `# == @deepseek-ai/dsh-bundle-base
- id: official-core
  name: '@deepseek-ai/plugin-core'
# == @deepseek-ai/dsh-bundle-web, patched by C:\\Users\\me\\.dsh\\profiles\\web\\cordis.patch.yml
- id: official-web
  name: '@deepseek-ai/plugin-web'
# == third-party-bundle
- id: old-market-plugin
  name: '@legacy/old-market-plugin'
# == C:\\Users\\me\\.dsh\\profiles\\web\\cordis.patch.yml
- id: "user-added"
  name: 'file:///C:/Users/me/plugin.js'
# == C:\\Temp\\embedded.patch.yml
- id: embedded-client
  name: 'file:///C:/HarnessDock/embedded.js'
`

describe('plugin recovery config dump parsing', () => {
  it('tracks row origin, patches and names without evaluating plugins', () => {
    const rows = parseConfigDumpRows(dump)
    expect(rows.map((row) => row.id)).toEqual(['official-core', 'official-web', 'old-market-plugin', 'user-added', 'embedded-client'])
    expect(rows[1]?.patchedBy).toEqual(['C:\\Users\\me\\.dsh\\profiles\\web\\cordis.patch.yml'])
    expect(rows[2]?.source).toBe('third-party-bundle')
    expect(rows[3]?.name).toBe('file:///C:/Users/me/plugin.js')
  })

  it('never selects official dsh rows or the HarnessDock bridge for fallback isolation', () => {
    const rows = parseConfigDumpRows(dump)
    expect(isOfficialDshSource('@deepseek-ai/dsh-bundle-web')).toBe(true)
    expect(isOfficialDshSource('C:\\runtime\\node_modules\\@deepseek-ai\\plugin')).toBe(true)
    expect(pluginRecoveryCandidates(rows).map((row) => row.id)).toEqual(['old-market-plugin', 'user-added'])
  })

  it('isolates the complete external set while attributing the plugin named by diagnostics', () => {
    const plan = buildPluginRecoveryPlan(
      parseConfigDumpRows(dump),
      'Failed to load @legacy/old-market-plugin while mounting old-market-plugin',
    )
    expect(plan.isolationRows.map((row) => row.id)).toEqual(['old-market-plugin', 'user-added'])
    expect(plan.suspectedRows.map((row) => row.id)).toEqual(['old-market-plugin'])
    expect(plan.reason).toBe('diagnostic-match')
    expect(selectPluginRecoveryRows(parseConfigDumpRows(dump), 'old-market-plugin failed').map((row) => row.id))
      .toEqual(['old-market-plugin', 'user-added'])
  })

  it('marks ambiguous failures without narrowing the external safety set', () => {
    const plan = buildPluginRecoveryPlan(parseConfigDumpRows(dump), 'Cordis boot failed during mount')
    expect(plan.isolationRows.map((row) => row.id)).toEqual(['old-market-plugin', 'user-added'])
    expect(plan.suspectedRows).toEqual([])
    expect(plan.reason).toBe('ambiguous')
  })

  it('keeps official and embedded plugins enabled when multiple third-party plugins are incompatible', () => {
    const selected = selectPluginRecoveryRows(parseConfigDumpRows(dump), 'old-market-plugin failed before user-added could initialize')
    expect(selected.map((row) => row.id)).toEqual(['old-market-plugin', 'user-added'])
    expect(selected.some((row) => row.id === 'official-core' || row.id === 'official-web' || row.id === 'embedded-client')).toBe(false)
  })

  it('renders a temporary disabled overlay and de-duplicates row ids', () => {
    expect(renderPluginRecoveryPatch([{ id: 'legacy' }, { id: 'legacy' }, { id: 'with quote " x' }]))
      .toBe('- id: "legacy"\n  disabled: true\n- id: "with quote \\" x"\n  disabled: true\n')
  })
})
