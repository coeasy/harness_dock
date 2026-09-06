import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apiVersion, apply, name, service, version } from '../src/index.ts'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '../..')
const read = (relative: string) => readFileSync(path.join(packageRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('independent Harness Shell dsh plugin', () => {
  it('publishes a generated contract-aligned manifest and distributable artifacts', () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'))
    const shellContract = JSON.parse(readFileSync(path.join(repoRoot, 'protocol/shell-contract.json'), 'utf8'))
    const commandNames = shellContract.commands.map((command: { name: string }) => command.name)
    const bundledEntry = read('lib/index.js')
    const bundledWeb = read('web/shell.js')

    expect(packageJson.private).not.toBe(true)
    expect(packageJson.files).toEqual(expect.arrayContaining(['lib', 'manifest.json', 'web']))
    expect({ name, version, apiVersion }).toEqual({
      name: shellContract.pluginId,
      version: packageJson.version,
      apiVersion: shellContract.apiVersion,
    })
    expect(service).toMatchObject({
      pluginId: shellContract.pluginId,
      version: packageJson.version,
      apiVersion: shellContract.apiVersion,
      capabilities: commandNames,
    })
    expect(manifest).toMatchObject({
      id: service.pluginId,
      version: service.version,
      kind: 'shell',
      apiVersion: service.apiVersion,
      safeMode: true,
      entry: 'lib/index.js',
      webEntry: 'web/shell.js',
    })
    expect(bundledEntry.trim().length).toBeGreaterThan(0)
    expect(bundledWeb.trim().length).toBeGreaterThan(0)
  })

  it('registers the shell service when the host accepts it', () => {
    let registeredKey = ''
    let registeredValue: typeof service | undefined
    apply({
      provide(key, value) {
        registeredKey = key
        registeredValue = value
      },
    })
    expect(registeredKey).toBe('harnessShell')
    expect(registeredValue).toBe(service)
  })

  it('fails open when an optional host registration hook throws', () => {
    expect(() => apply({
      provide() {
        throw new Error('host registry unavailable')
      },
    })).not.toThrow()

    expect(() => apply({
      set() {
        throw new Error('legacy host registry unavailable')
      },
    })).not.toThrow()
  })
})
