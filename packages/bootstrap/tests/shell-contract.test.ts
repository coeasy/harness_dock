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
    expect(SHELL_API_VERSION).toBe(1)
    expect(SHELL_COMMANDS).toContain('web.reload')
    expect(SHELL_COMMANDS).toContain('runtime.safe-mode')
    expect(SHELL_COMMANDS).toContain('app.update.install')
    expect(isShellCommandName('window.close')).toBe(true)
    expect(isShellCommandName('settings.open')).toBe(false)
  })

  it('defaults unspecified capabilities to enabled', () => {
    expect(normalizeShellCapabilities({ 'window.close': false })).toMatchObject({
      'window.close': false,
      'web.reload': true,
      'runtime.safe-mode': true,
    })
  })

  it('rejects an incompatible host bridge', () => {
    expect(() => assertShellBridgeVersion(2)).toThrow(/expected 1/)
    expect(() => assertShellBridgeVersion(1)).not.toThrow()
  })
})
