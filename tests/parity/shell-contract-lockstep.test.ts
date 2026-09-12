import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Harness Shell contract is declared in four places that used to drift
 * apart unnoticed:
 *
 *   1. `packages/bootstrap/src/shell-contract.ts`  — the TS command union
 *   2. `packages/plugin-harness-shell/src/index.ts` — the plugin's advertised
 *      capabilities and its own `apiVersion`
 *   3. `apps/tauri/src-tauri/src/harness_shell.rs` — the injected BRIDGE_SCRIPT
 *      that maps command names to Tauri commands / host protocol wire names
 *   4. `apps/tauri/src-tauri/src/capability_broker.rs` — the allow/deny decision
 *
 * Before this suite existed, `SHELL_COMMANDS` listed 13 commands while the
 * bridge wired only 9, and the plugin entrypoint still published
 * `apiVersion = 1` after the bridge moved to 2. Both were invisible because the
 * only gate compared (1) against (3) on version alone.
 *
 * These tests assert the full cross product, so any future single-sided edit
 * fails CI instead of shipping a command the host silently rejects.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const readJson = (relative: string) => JSON.parse(read(relative))

/** Command names are dotted paths with two or more segments. */
const COMMAND_NAME = "'([a-z]+(?:\\.[A-Za-z-]+)+)'"
const commandPattern = (flags = 'g') => new RegExp(COMMAND_NAME, flags)

/** Members of the `SHELL_COMMANDS` array literal in shell-contract.ts. */
function contractCommands(): string[] {
  const contract = read('packages/bootstrap/src/shell-contract.ts')
  return [...contract.matchAll(new RegExp(`^ {2}${COMMAND_NAME},?$`, 'gm'))].map((m) => m[1])
}

/** The `capabilities` array advertised by the shell plugin entrypoint. */
function entryCapabilities(): string[] {
  const entry = read('packages/plugin-harness-shell/src/index.ts')
  return [...entry.matchAll(commandPattern())].map((m) => m[1])
}

/** Command names wired into BRIDGE_SCRIPT, split by routing strategy. */
function bridgeWiring() {
  const bridge = read('apps/tauri/src-tauri/src/harness_shell.rs')
  const directWindowMap = bridge
    .slice(bridge.indexOf('const directWindowMap'), bridge.indexOf('const hostCommandMap'))
  const hostCommandMap = bridge.slice(
    bridge.indexOf('const hostCommandMap'),
    bridge.indexOf('const capabilities'),
  )
  // Values differ per branch: direct window calls are Tauri command names
  // (`harness_minimize`) while host-routed entries are wire names
  // (`refresh-harness`), so underscores must be allowed alongside hyphens.
  const pairs = (block: string) =>
    [...block.matchAll(new RegExp(`^ {4}${COMMAND_NAME}: '([A-Za-z_-]+)',?$`, 'gm'))].map(
      (m) => [m[1], m[2]] as const,
    )
  return { direct: pairs(directWindowMap), host: pairs(hostCommandMap) }
}

function protocolWireNames(): Set<string> {
  const protocol = readJson('protocol/host-protocol-v2.json')
  return new Set<string>((protocol.commands ?? []).map((command: { wire: string }) => command.wire))
}

describe('Harness Shell contract lockstep', () => {
  it('publishes one apiVersion across the bridge, the TS contract and the plugin entrypoint', () => {
    const bridgeApi = read('apps/tauri/src-tauri/src/harness_shell.rs').match(
      /apiVersion:\s*(\d+)/,
    )?.[1]
    const contractApi = read('packages/bootstrap/src/shell-contract.ts').match(
      /SHELL_API_VERSION\s*=\s*(\d+)\s*as\s+const/,
    )?.[1]
    const entryApi = read('packages/plugin-harness-shell/src/index.ts').match(
      /export const apiVersion = (\d+) as const/,
    )?.[1]

    // All three must be found, or the assertion below would pass on undefined.
    expect(bridgeApi).toBeTruthy()
    expect(contractApi).toBeTruthy()
    expect(entryApi).toBeTruthy()
    expect(new Set([bridgeApi, contractApi, entryApi]).size).toBe(1)
  })

  it('advertises exactly the contract command set from the plugin entrypoint', () => {
    const contract = contractCommands()
    const entry = entryCapabilities()
    expect(contract.length).toBeGreaterThan(0)
    expect(new Set(contract)).toEqual(new Set(entry))
  })

  it('wires every contract command into the bridge with no orphans', () => {
    const contract = contractCommands()
    const { direct, host } = bridgeWiring()
    const wired = new Set([...direct.map(([c]) => c), ...host.map(([c]) => c)])

    // No declared command may be unreachable from the web surface.
    expect(contract.filter((command) => !wired.has(command))).toEqual([])
    // No wired command may be missing from the declared contract.
    expect([...wired].filter((command) => !contract.includes(command))).toEqual([])
  })

  it('maps every host-routed command to a wire name that exists in host protocol v2', () => {
    const { host } = bridgeWiring()
    const wires = protocolWireNames()
    expect(host.length).toBeGreaterThan(0)
    const unknown = host.map(([, wire]) => wire).filter((wire) => !wires.has(wire))
    expect(unknown).toEqual([])
  })

  it('routes window commands directly and all other commands through host_execute', () => {
    const { direct, host } = bridgeWiring()
    const bridge = read('apps/tauri/src-tauri/src/harness_shell.rs')

    // Window controls are local UI operations and intentionally bypass the
    // host protocol; everything else must be brokered.
    for (const [command] of direct) {
      expect(command.startsWith('window.')).toBe(true)
    }
    for (const [command] of host) {
      expect(command.startsWith('window.')).toBe(false)
    }
    // The two routing branches must actually exist in the invoke dispatch.
    expect(bridge).toContain("hasOwnProperty.call(directWindowMap, command)")
    expect(bridge).toContain("hasOwnProperty.call(hostCommandMap, command)")
    expect(bridge).toContain("tauriInvoke('host_execute'")
  })

  it('only advertises capabilities the broker allows for the HarnessWeb subject', () => {
    const broker = read('apps/tauri/src-tauri/src/capability_broker.rs')
    const { host } = bridgeWiring()

    // The broker branches on `Capability`, not on command names, so the wire
    // name must first be resolved to its capability via the protocol file.
    const allowed = brokerAllowedCapabilitiesForWeb(broker)
    expect(allowed.size).toBeGreaterThan(0)

    const denied = host
      .map(([command, wire]) => [command, wire, capabilityForWire(wire)] as const)
      .filter(([, , capability]) => capability !== null && !allowed.has(capability))
      .map(([command, wire, capability]) => `${command} -> ${wire} (${capability})`)

    // Wiring a command the broker denies to web would let a page await a
    // rejection forever. It is also why commands such as
    // `runtime.clear-quarantine` live on the native surfaces only.
    expect(denied).toEqual([])
  })

  it('keeps the broker allow-list exhaustive over every declared capability', () => {
    const broker = read('apps/tauri/src-tauri/src/capability_broker.rs')
    const declared = brokerDeclaredCapabilities(broker)

    // The HarnessWeb branch is an exhaustive `match` over Capability, so the
    // Rust compiler is what actually enforces deny-by-default: adding a new
    // capability fails to compile until someone decides Allow or Deny. This
    // test guards the weaker sibling — that every capability listed in
    // ALL_CAPABILITIES is named in the web branch.
    const webBranch = broker.slice(
      broker.indexOf('if request.subject == SubjectKind::HarnessWeb'),
      broker.indexOf('match request.subject {'),
    )
    const missing = declared.filter((capability) => !webBranch.includes(capability))
    expect(missing).toEqual([])
    expect(declared.length).toBe(17)
  })
})

/** Capabilities the broker returns `Allow` for when the subject is HarnessWeb. */
function brokerAllowedCapabilitiesForWeb(broker: string): Set<string> {
  const branch = broker.slice(
    broker.indexOf('if request.subject == SubjectKind::HarnessWeb'),
    broker.indexOf('match request.subject {'),
  )
  // The capability list precedes the `=> Decision::Allow` arm it feeds, so the
  // slice runs from the `match` header up to (not including) that arm.
  const allowBlock = branch.slice(
    branch.indexOf('return match request.capability {'),
    branch.indexOf('=> Decision::Allow'),
  )
  return new Set(
    [...allowBlock.matchAll(/Capability::([A-Za-z]+)/g)].map((match) => match[1]),
  )
}

/** Members of `ALL_CAPABILITIES` in the broker. */
function brokerDeclaredCapabilities(broker: string): string[] {
  const block = broker.slice(
    broker.indexOf('pub(crate) const ALL_CAPABILITIES'),
    broker.indexOf('pub(crate) fn capability_for'),
  )
  return [...block.matchAll(/Capability::([A-Za-z]+)/g)].map((match) => match[1])
}

/** Resolves a protocol wire name to its `Capability` variant name. */
function capabilityForWire(wire: string): string | null {
  const protocol = readJson('protocol/host-protocol-v2.json')
  const match = (protocol.commands ?? []).find((command: { wire: string }) => command.wire === wire)
  return match ? (match as { capability: string }).capability : null
}
