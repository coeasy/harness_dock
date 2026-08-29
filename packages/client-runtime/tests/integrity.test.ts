import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertBundledRuntimeIntegrity,
  repairKnownRuntimeAssets,
  requiredNativePackages,
} from '../src/integrity.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function packageFixture(runtimeDir: string, packageName: string): Promise<void> {
  const dir = path.join(runtimeDir, 'node_modules', ...packageName.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName }), 'utf8')
}

describe('bundled runtime integrity', () => {
  it('maps native packages for every published target', () => {
    expect(requiredNativePackages('win32', 'x64')).toContain('@img/sharp-win32-x64')
    expect(requiredNativePackages('darwin', 'arm64')).toContain('@koromix/koffi-darwin-arm64')
    expect(requiredNativePackages('linux', 'x64')).toContain(
      'node-addon-require-builtin-linux-x64-gnu',
    )
  })

  it('repairs the pi-ai 0.82.1 hidden manifest omitted from npm', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-integrity-'))
    temps.push(runtimeDir)
    const packageDir = path.join(
      runtimeDir,
      'node_modules',
      '@earendil-works',
      'pi-ai',
    )
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.82.1' }),
      'utf8',
    )

    const repaired = await repairKnownRuntimeAssets(runtimeDir)
    expect(repaired).toHaveLength(1)
    const manifest = path.join(packageDir, 'dist', 'providers', 'data', '.manifest.json')
    await expect(access(manifest)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({
      repairedBy: 'HarnessDock',
      sourcePackage: '@earendil-works/pi-ai@0.82.1',
    })
    expect(await repairKnownRuntimeAssets(runtimeDir)).toEqual([])
  })

  it('fails when a target-native package is absent', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-integrity-'))
    temps.push(runtimeDir)
    await packageFixture(runtimeDir, '@deepseek-ai/dsh')
    await packageFixture(runtimeDir, '@earendil-works/pi-ai')
    for (const packageName of requiredNativePackages('win32', 'x64').slice(1)) {
      await packageFixture(runtimeDir, packageName)
    }
    const manifest = path.join(
      runtimeDir,
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'providers',
      'data',
      '.manifest.json',
    )
    await mkdir(path.dirname(manifest), { recursive: true })
    await writeFile(manifest, '{}', 'utf8')

    await expect(assertBundledRuntimeIntegrity(runtimeDir, 'win32', 'x64')).rejects.toThrow(
      'node-addon-require-builtin-win32-x64-msvc',
    )
  })
})
