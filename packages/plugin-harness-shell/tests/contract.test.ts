import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, service } from '../src/index.ts'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('independent Harness Shell dsh plugin', () => {
  it('publishes a versioned manifest and distributable entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'))
    const entry = readFileSync(path.join(packageRoot, 'src', 'index.ts'), 'utf8')
    const web = readFileSync(path.join(packageRoot, 'src', 'web', 'shell.js'), 'utf8')
    const bundledEntry = readFileSync(path.join(packageRoot, 'lib', 'index.js'), 'utf8')
    const bundledWeb = readFileSync(path.join(packageRoot, 'web', 'shell.js'), 'utf8')
    expect(packageJson.private).not.toBe(true)
    expect(packageJson.files).toEqual(expect.arrayContaining(['lib', 'manifest.json', 'web']))
    expect(manifest).toMatchObject({
      id: 'harness-shell',
      version: packageJson.version,
      kind: 'shell',
      apiVersion: 1,
      safeMode: true,
    })
    expect(entry).toContain("export const name = 'harness-shell'")
    expect(entry).toContain(`export const version = '${packageJson.version}'`)
    expect(entry).toContain("register?.('harnessShell', service)")
    expect(web).toContain('window.__DSH_SHELL_BRIDGE__')
    expect(web).toContain('runtime.safe-mode')
    expect(web).toContain('gateway.manage')
    expect(web).toContain('移动设备 / Gateway')
    expect(web).toContain('app.update.install')
    expect(web).toContain('isWindowCommand')
    expect(web).toContain('setBusinessActionsDisabled')
    expect(web).toContain("window.addEventListener('pagehide'")
    expect(bundledEntry).toContain('harness-shell')
    expect(bundledEntry).toContain('register?.("harnessShell", service)')
    expect(bundledWeb).toContain('window.__DSH_SHELL_BRIDGE__')
    expect(bundledWeb).toContain('gateway.manage')
    expect(bundledWeb).toContain('isWindowCommand')
    expect(bundledWeb).toContain("window.addEventListener('pagehide'")
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
