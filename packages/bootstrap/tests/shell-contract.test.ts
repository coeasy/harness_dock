import { describe, expect, it } from 'vitest'
import {
  SHELL_API_VERSION,
  SHELL_COMMANDS,
  assertShellBridgeVersion,
  isShellCommandName,
  normalizeShellCapabilities,
} from '../src/shell-contract.ts'

describe('Harness shell contract', () => {
  it('keeps the public command set stable and versioned', () => {
    // v2 aligns with the desktop BRIDGE_SCRIPT (`harness_shell.rs` publishes
    // `apiVersion: 2`); the `check:shell-package` gate enforces lockstep.
    expect(SHELL_API_VERSION).toBe(2)
    expect(SHELL_COMMANDS).toContain('web.reload')
    expect(SHELL_COMMANDS).toContain('runtime.safe-mode')
    expect(SHELL_COMMANDS).toContain('gateway.manage')
    // Web-unreachable commands stay out of the contract: `capability_broker.rs`
    // denies them to the HarnessWeb subject, so advertising them here would let
    // a page await a command the host is guaranteed to reject.
    expect(SHELL_COMMANDS).not.toContain('app.update.install')
    expect(SHELL_COMMANDS).not.toContain('app.quit')
    expect(isShellCommandName('window.close')).toBe(true)
    expect(isShellCommandName('settings.open')).toBe(false)
  })

  it('defaults unspecified capabilities to disabled (deny-by-default)', () => {
    expect(normalizeShellCapabilities({ 'window.close': false })).toMatchObject({
      'window.close': false,
      'web.reload': false,
      'runtime.safe-mode': false,
    })
  })

  it('enables only explicitly declared capabilities', () => {
    expect(normalizeShellCapabilities({ 'web.reload': true })).toMatchObject({
      'web.reload': true,
      'window.close': false,
      'gateway.manage': false,
    })
    // An undefined capability map grants nothing.
    expect(normalizeShellCapabilities(undefined)).toMatchObject({
      'web.reload': false,
      'window.close': false,
    })
  })

  it('rejects an incompatible host bridge', () => {
    expect(() => assertShellBridgeVersion(1)).toThrow(/expected 2/)
    expect(() => assertShellBridgeVersion(2)).not.toThrow()
  })
})