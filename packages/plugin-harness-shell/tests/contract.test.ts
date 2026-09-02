import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
      version: '0.2.0',
      kind: 'shell',
      apiVersion: 1,
      safeMode: true,
    })
    expect(entry).toContain("export const name = 'harness-shell'")
    expect(entry).toContain("export const version = '0.2.0'")
    expect(web).toContain('window.__DSH_SHELL_BRIDGE__')
    expect(web).toContain('runtime.safe-mode')
    expect(web).toContain('app.update.install')
    expect(bundledEntry).toContain('harness-shell')
    expect(bundledWeb).toContain('window.__DSH_SHELL_BRIDGE__')
  })
})
