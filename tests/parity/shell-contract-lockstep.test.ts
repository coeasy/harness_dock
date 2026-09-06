import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SHELL_API_VERSION as BOOTSTRAP_API_VERSION,
  SHELL_COMMANDS as BOOTSTRAP_COMMANDS,
  SHELL_PLUGIN_ID as BOOTSTRAP_PLUGIN_ID,
  SHELL_VERSION as BOOTSTRAP_VERSION,
} from '../../packages/bootstrap/src/shell-contract.generated.ts'
import {
  SHELL_API_VERSION as PLUGIN_API_VERSION,
  SHELL_COMMANDS as PLUGIN_COMMANDS,
  SHELL_PLUGIN_ID as PLUGIN_ID,
  SHELL_VERSION as PLUGIN_VERSION,
} from '../../packages/plugin-harness-shell/src/shell-contract.generated.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (relative: string) =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'))

interface ShellCommandRow {
  name: string
  route: 'direct' | 'host'
  target: string
}

const contract = readJson('protocol/shell-contract.json') as {
  schemaVersion: number
  apiVersion: number
  pluginId: string
  commands: ShellCommandRow[]
}
const pluginManifest = readJson('packages/plugin-harness-shell/manifest.json')
const releaseManifest = readJson('release-manifest.json')
const hostProtocol = readJson('protocol/host-protocol-v2.json')

describe('Harness Shell structured contract lockstep', () => {
  it('has one canonical api/plugin/version identity across generated consumers and release manifests', () => {
    expect(contract.schemaVersion).toBe(1)
    expect(BOOTSTRAP_API_VERSION).toBe(contract.apiVersion)
    expect(PLUGIN_API_VERSION).toBe(contract.apiVersion)
    expect(pluginManifest.apiVersion).toBe(contract.apiVersion)
    expect(releaseManifest.shell.apiVersion).toBe(contract.apiVersion)

    expect(BOOTSTRAP_PLUGIN_ID).toBe(contract.pluginId)
    expect(PLUGIN_ID).toBe(contract.pluginId)
    expect(pluginManifest.id).toBe(contract.pluginId)

    expect(BOOTSTRAP_VERSION).toBe(PLUGIN_VERSION)
    expect(pluginManifest.version).toBe(PLUGIN_VERSION)
    expect(releaseManifest.shell.version).toBe(PLUGIN_VERSION)
  })

  it('generates the exact public command list without order or source-location coupling', () => {
    const canonical = contract.commands.map((row) => row.name)
    expect(new Set(canonical).size).toBe(canonical.length)
    expect([...BOOTSTRAP_COMMANDS]).toEqual(canonical)
    expect([...PLUGIN_COMMANDS]).toEqual(canonical)
  })

  it('keeps direct routes limited to native window primitives', () => {
    const direct = contract.commands.filter((row) => row.route === 'direct')
    expect(direct.length).toBeGreaterThan(0)
    expect(direct.every((row) => row.name.startsWith('window.'))).toBe(true)
    expect(direct.every((row) => row.target.startsWith('harness_'))).toBe(true)
  })

  it('maps every host route to a declared Host Protocol v2 wire command', () => {
    const wires = new Set<string>(
      (hostProtocol.commands ?? []).map((row: { wire: string }) => row.wire),
    )
    const hostRows = contract.commands.filter((row) => row.route === 'host')
    expect(hostRows.length).toBeGreaterThan(0)
    expect(hostRows.filter((row) => !wires.has(row.target))).toEqual([])
    expect(hostRows.every((row) => !row.name.startsWith('window.'))).toBe(true)
  })

  it('does not expose privileged native-only host commands to Harness Web', () => {
    const publicTargets = new Set(
      contract.commands.filter((row) => row.route === 'host').map((row) => row.target),
    )
    for (const privileged of ['clear-quarantine', 'install-update', 'quit']) {
      expect(publicTargets.has(privileged)).toBe(false)
    }
  })
})
