import { describe, expect, it } from 'vitest'
import { npxCommand, resolveDshCommand } from '../src/resolve.ts'

describe('npxCommand', () => {
  it('uses npx.cmd on Windows so spawn does not ENOENT', () => {
    expect(npxCommand('win32', {})).toBe('npx.cmd')
    expect(npxCommand('linux', {})).toBe('npx')
    expect(npxCommand('darwin', {})).toBe('npx')
  })

  it('honors NPX_BIN override on every platform', () => {
    expect(npxCommand('win32', { NPX_BIN: 'C:\\tools\\npx.cmd' })).toBe('C:\\tools\\npx.cmd')
  })
})

describe('resolveDshCommand', () => {
  it('download mode pins an exact npm version and never latest', async () => {
    const resolved = await resolveDshCommand({
      mode: 'download',
      version: '0.1.1-rc.2',
      env: {},
      platform: 'linux',
    })
    expect(resolved.command).toBe('npx')
    expect(resolved.argsPrefix).toEqual(['--yes', '@deepseek-ai/dsh@0.1.1-rc.2'])
  })

  it('bundled mode uses vendored node.exe plus the pinned dsh bin.js', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-res-'))
    mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'node.exe'), '')
    writeFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
    const resolved = await resolveDshCommand({
      mode: 'bundled',
      version: '0.1.1-rc.2',
      env: {},
      bundledRoot: dir,
      platform: 'win32',
    })
    expect(resolved.command).toBe(path.join(dir, 'node.exe'))
    expect(resolved.argsPrefix).toEqual([
      path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ])
    await rm(dir, { recursive: true, force: true })
  })

  it('download mode on Windows spawns npx.cmd', async () => {
    const resolved = await resolveDshCommand({
      mode: 'download',
      version: '0.1.1-rc.2',
      env: {},
      platform: 'win32',
    })
    expect(resolved.command).toBe('npx.cmd')
  })
})
