import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertBundledPnpm,
  bundledPnpmShim,
  PNPM_BUNDLE_VERSION,
  writeBundledPnpmShim,
} from '../src/pnpm-tool.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runtimeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-pnpm-'))
  temps.push(root)
  const packageDir = path.join(root, 'tools', 'pnpm', 'node_modules', 'pnpm')
  await mkdir(path.join(packageDir, 'bin'), { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: PNPM_BUNDLE_VERSION }))
  await writeFile(path.join(packageDir, 'bin', 'pnpm.cjs'), 'console.log("pnpm")')
  return root
}

describe('bundled pnpm tool', () => {
  it('writes a Windows shim that uses the embedded Node runtime', async () => {
    const root = await runtimeFixture()
    const shim = await writeBundledPnpmShim(root, 'win32')
    const source = await readFile(shim, 'utf8')
    expect(shim).toBe(bundledPnpmShim(root, 'win32'))
    expect(source).toContain('..\\..\\node.exe')
    expect(source).toContain('..\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs')
    await expect(assertBundledPnpm(root, 'win32')).resolves.toBeUndefined()
  })

  it('writes an executable Unix shim that uses bin/node', async () => {
    const root = await runtimeFixture()
    const shim = await writeBundledPnpmShim(root, 'linux')
    const source = await readFile(shim, 'utf8')
    const details = await stat(shim)
    expect(source).toContain('$SCRIPT_DIR/../../bin/node')
    expect(source).toContain('$SCRIPT_DIR/../pnpm/node_modules/pnpm/bin/pnpm.cjs')
    expect(details.mode & 0o111).not.toBe(0)
    await expect(assertBundledPnpm(root, 'linux')).resolves.toBeUndefined()
  })

  it('rejects an unexpected bundled pnpm version', async () => {
    const root = await runtimeFixture()
    await writeBundledPnpmShim(root, 'linux')
    const packageFile = path.join(root, 'tools', 'pnpm', 'node_modules', 'pnpm', 'package.json')
    await writeFile(packageFile, JSON.stringify({ version: '0.0.1' }))
    await chmod(bundledPnpmShim(root, 'linux'), 0o755)
    await expect(assertBundledPnpm(root, 'linux')).rejects.toThrow('bundled pnpm version')
  })
})
