import { describe, expect, it } from 'vitest'
import { buildSpawnRequest, isWindowsScriptCommand, quoteForCmd } from '../src/shell.ts'

describe('isWindowsScriptCommand', () => {
  it('matches .cmd/.bat commands on win32', () => {
    expect(isWindowsScriptCommand('npx.cmd', 'win32')).toBe(true)
    expect(isWindowsScriptCommand('NPX.CMD', 'win32')).toBe(true)
    expect(isWindowsScriptCommand('C:\\Program Files\\nodejs\\npx.cmd', 'win32')).toBe(true)
    expect(isWindowsScriptCommand('script.bat', 'win32')).toBe(true)
  })

  it('does not match plain executables or other platforms', () => {
    expect(isWindowsScriptCommand('node.exe', 'win32')).toBe(false)
    expect(isWindowsScriptCommand('npx', 'linux')).toBe(false)
    expect(isWindowsScriptCommand('npx.cmd', 'linux')).toBe(false)
  })
})

describe('buildSpawnRequest', () => {
  it('routes .cmd through cmd.exe with a quoted command line', () => {
    const request = buildSpawnRequest(
      'npx.cmd',
      ['--yes', '@deepseek-ai/dsh@0.1.1-rc.2', 'web', '--patch', 'C:\\temp dir\\embedded.patch.yml'],
      'win32',
    )
    expect(request.command).toBe('cmd.exe')
    expect(request.args).toEqual([
      '/d',
      '/s',
      '/c',
      'npx.cmd --yes @deepseek-ai/dsh@0.1.1-rc.2 web --patch "C:\\temp dir\\embedded.patch.yml"',
    ])
  })

  it('leaves non-script commands untouched', () => {
    const request = buildSpawnRequest('/usr/bin/env', ['--yes'], 'linux')
    expect(request).toEqual({ command: '/usr/bin/env', args: ['--yes'] })
  })

  it('leaves node executables untouched on win32', () => {
    const request = buildSpawnRequest('C:\\runtime\\node.exe', ['bin.js', 'web'], 'win32')
    expect(request).toEqual({ command: 'C:\\runtime\\node.exe', args: ['bin.js', 'web'] })
  })
})

describe('quoteForCmd', () => {
  it('keeps simple tokens as-is', () => {
    expect(quoteForCmd('--yes')).toBe('--yes')
    expect(quoteForCmd('@deepseek-ai/dsh@0.1.1-rc.2')).toBe('@deepseek-ai/dsh@0.1.1-rc.2')
  })

  it('quotes tokens with spaces and doubles embedded quotes', () => {
    expect(quoteForCmd('C:\\temp dir\\file.yml')).toBe('"C:\\temp dir\\file.yml"')
    expect(quoteForCmd('a "b" c')).toBe('"a ""b"" c"')
    expect(quoteForCmd('')).toBe('""')
  })
})
