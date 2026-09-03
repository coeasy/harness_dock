import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  plannedNodeDistributionPrune,
  pruneBundledNodeDistribution,
} from '../src/node-runtime-prune.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('plannedNodeDistributionPrune', () => {
  it('removes package-manager/developer payloads from Windows Node distributions', () => {
    const paths = plannedNodeDistributionPrune('win32')
    expect(paths).toContain(path.join('node_modules', 'npm'))
    expect(paths).toContain(path.join('node_modules', 'corepack'))
    expect(paths).toContain('npm.cmd')
    expect(paths).toContain('corepack.cmd')
    expect(paths).not.toContain('node_modules')
    expect(paths).not.toContain('node.exe')
    expect(paths).not.toContain('LICENSE')
  })

  it('removes Unix package managers, headers and share data but keeps bin/node', () => {
    const paths = plannedNodeDistributionPrune('linux')
    expect(paths).toContain(path.join('bin', 'npm'))
    expect(paths).toContain(path.join('lib', 'node_modules'))
    expect(paths).toContain('include')
    expect(paths).toContain('share')
    expect(paths).not.toContain(path.join('bin', 'node'))
    expect(paths).not.toContain('LICENSE')
  })
})

describe('pruneBundledNodeDistribution', () => {
  it('keeps the Windows Node executable, license and dsh closure while removing npm/corepack', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-node-win-'))
    temps.push(root)
    await writeFile(path.join(root, 'node.exe'), 'node-runtime')
    await writeFile(path.join(root, 'LICENSE'), 'node-license')
    await writeFile(path.join(root, 'README.md'), 'readme')
    await writeFile(path.join(root, 'npm.cmd'), 'npm')
    await writeFile(path.join(root, 'corepack.cmd'), 'corepack')
    await mkdir(path.join(root, 'node_modules', 'npm'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'corepack'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'npm', 'index.js'), 'npm-package')
    await writeFile(path.join(root, 'node_modules', 'corepack', 'index.js'), 'corepack-package')
    await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}')

    const result = await pruneBundledNodeDistribution(root, 'win32', () => undefined)

    expect(result.removedCount).toBe(5)
    expect(result.removedBytes).toBeGreaterThan(0)
    expect(await exists(path.join(root, 'node.exe'))).toBe(true)
    expect(await exists(path.join(root, 'LICENSE'))).toBe(true)
    expect(await exists(path.join(root, 'README.md'))).toBe(false)
    expect(await exists(path.join(root, 'npm.cmd'))).toBe(false)
    expect(await exists(path.join(root, 'corepack.cmd'))).toBe(false)
    expect(await exists(path.join(root, 'node_modules', 'npm'))).toBe(false)
    expect(await exists(path.join(root, 'node_modules', 'corepack'))).toBe(false)
    expect(await exists(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))).toBe(true)
  })

  it('keeps bin/node on Unix and removes headers, docs and bundled package managers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-node-unix-'))
    temps.push(root)
    await mkdir(path.join(root, 'bin'), { recursive: true })
    await mkdir(path.join(root, 'include', 'node'), { recursive: true })
    await mkdir(path.join(root, 'share', 'man'), { recursive: true })
    await mkdir(path.join(root, 'lib', 'node_modules', 'npm'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(path.join(root, 'bin', 'node'), 'node-runtime')
    await writeFile(path.join(root, 'bin', 'npm'), 'npm-link-or-wrapper')
    await writeFile(path.join(root, 'LICENSE'), 'node-license')
    await writeFile(path.join(root, 'include', 'node', 'node.h'), 'header')
    await writeFile(path.join(root, 'share', 'man', 'node.1'), 'manual')
    await writeFile(path.join(root, 'lib', 'node_modules', 'npm', 'index.js'), 'npm-package')
    await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}')

    const result = await pruneBundledNodeDistribution(root, 'linux', () => undefined)

    expect(result.removedCount).toBe(4)
    expect(await exists(path.join(root, 'bin', 'node'))).toBe(true)
    expect(await exists(path.join(root, 'LICENSE'))).toBe(true)
    expect(await exists(path.join(root, 'bin', 'npm'))).toBe(false)
    expect(await exists(path.join(root, 'include'))).toBe(false)
    expect(await exists(path.join(root, 'share'))).toBe(false)
    expect(await exists(path.join(root, 'lib', 'node_modules'))).toBe(false)
    expect(await exists(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))).toBe(true)
  })
})
