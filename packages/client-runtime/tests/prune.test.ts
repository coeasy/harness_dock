import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  planDevFilesToPrune,
  planPrebuildPrune,
  planRuntimeDocFilesToPrune,
  planRuntimePrune,
  planSdkDirsToPrune,
  pruneBundledRuntime,
} from '../src/prune.ts'

const allVariants = [
  '@img/sharp-wasm32',
  '@img/sharp-freebsd-wasm32',
  '@img/sharp-webcontainers-wasm32',
  '@img/sharp-darwin-arm64',
  '@img/sharp-darwin-x64',
  '@img/sharp-linux-arm',
  '@img/sharp-linux-arm64',
  '@img/sharp-linux-ppc64',
  '@img/sharp-linux-riscv64',
  '@img/sharp-linux-s390x',
  '@img/sharp-linux-x64',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-linuxmusl-x64',
  '@img/sharp-win32-arm64',
  '@img/sharp-win32-ia32',
  '@img/sharp-win32-x64',
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-libvips-linux-arm',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linux-ppc64',
  '@img/sharp-libvips-linux-riscv64',
  '@img/sharp-libvips-linux-s390x',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-libvips-win32-arm64',
  '@img/sharp-libvips-win32-ia32',
  '@img/sharp-libvips-win32-x64',
]

describe('planRuntimePrune', () => {
  it('keeps only the host variant and wasm32 on win32/x64', () => {
    const toDelete = planRuntimePrune(allVariants, 'win32', 'x64')
    expect(toDelete).not.toContain('@img/sharp-win32-x64')
    expect(toDelete).not.toContain('@img/sharp-libvips-win32-x64')
    expect(toDelete).not.toContain('@img/sharp-wasm32')
    expect(toDelete).toContain('@img/sharp-darwin-arm64')
    expect(toDelete).toContain('@img/sharp-linux-x64')
    expect(toDelete).toContain('@img/sharp-linuxmusl-arm64')
    expect(toDelete).toContain('@img/sharp-libvips-darwin-arm64')
    expect(toDelete).toContain('@img/sharp-libvips-linuxmusl-x64')
    expect(toDelete).toContain('@img/sharp-win32-ia32')
    // everything except the win32-x64 pair and wasm32 is pruned
    expect(toDelete.length).toBe(allVariants.length - 3)
  })

  it('keeps linux and linuxmusl variants on linux hosts', () => {
    const toDelete = planRuntimePrune(allVariants, 'linux', 'x64')
    expect(toDelete).not.toContain('@img/sharp-linux-x64')
    expect(toDelete).not.toContain('@img/sharp-linuxmusl-x64')
    expect(toDelete).not.toContain('@img/sharp-libvips-linux-x64')
    expect(toDelete).not.toContain('@img/sharp-libvips-linuxmusl-x64')
    expect(toDelete).not.toContain('@img/sharp-wasm32')
    expect(toDelete).toContain('@img/sharp-win32-x64')
    expect(toDelete).toContain('@img/sharp-darwin-arm64')
    expect(toDelete.length).toBe(allVariants.length - 5)
  })

  it('keeps the arm64 variant on darwin/arm64', () => {
    const toDelete = planRuntimePrune(allVariants, 'darwin', 'arm64')
    expect(toDelete).not.toContain('@img/sharp-darwin-arm64')
    expect(toDelete).not.toContain('@img/sharp-libvips-darwin-arm64')
    expect(toDelete).not.toContain('@img/sharp-wasm32')
    expect(toDelete).toContain('@img/sharp-darwin-x64')
    expect(toDelete).toContain('@img/sharp-linux-arm64')
    expect(toDelete.length).toBe(allVariants.length - 3)
  })

  it('leaves non-sharp packages untouched', () => {
    const names = [...allVariants, '@img/colour', 'sharp', 'lodash', 'node-pty']
    const toDelete = planRuntimePrune(names, 'win32', 'x64')
    expect(toDelete).not.toContain('@img/colour')
    expect(toDelete).not.toContain('sharp')
    expect(toDelete).not.toContain('lodash')
    expect(toDelete).not.toContain('node-pty')
  })

  it('keeps only wasm32 for unsupported arches', () => {
    const toDelete = planRuntimePrune(allVariants, 'linux', 'ia32')
    expect(toDelete).not.toContain('@img/sharp-wasm32')
    expect(toDelete).toContain('@img/sharp-linux-x64')
    expect(toDelete.length).toBe(allVariants.length - 1)
  })
})

describe('planPrebuildPrune', () => {
  const names = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']

  it('keeps only the host prebuild variant on win32/x64', () => {
    expect(planPrebuildPrune(names, 'win32', 'x64')).toEqual([
      'win32-arm64',
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
    ])
  })

  it('keeps linux and linuxmusl on linux hosts', () => {
    expect(planPrebuildPrune(['linux-x64', 'linuxmusl-x64', 'linux-arm64'], 'linux', 'x64')).toEqual([
      'linux-arm64',
    ])
  })

  it('keeps the arm64 prebuild on darwin/arm64', () => {
    expect(planPrebuildPrune(names, 'darwin', 'arm64')).toEqual([
      'win32-x64',
      'win32-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
    ])
  })
})

describe('planDevFilesToPrune', () => {
  it('flags .map/.pdb/.d.ts but leaves runtime files untouched', () => {
    const names = ['index.js.map', 'conpty.pdb', 'types.d.ts', 'index.js', 'bin.js', 'logo.png']
    expect(planDevFilesToPrune(names)).toEqual(['index.js.map', 'conpty.pdb', 'types.d.ts'])
  })
})

describe('planSdkDirsToPrune', () => {
  it('flags SDK dev/example dirs at package top level', () => {
    const names = [
      'some-pkg/test',
      'other-pkg/tests',
      'pkg3/__tests__',
      'pkg4/examples',
      'pkg5/coverage',
      'pkg6/.yarn',
      'index.js',
    ]
    expect(planSdkDirsToPrune(names)).toEqual([
      'some-pkg/test',
      'other-pkg/tests',
      'pkg3/__tests__',
      'pkg4/examples',
      'pkg5/coverage',
      'pkg6/.yarn',
    ])
  })

  it('keeps test dirs under @types/* and under src', () => {
    const names = [
      '@types/lodash/test',
      '@types/node/tests',
      'some-pkg/src/test',
      '@scope/pkg/src/__tests__',
      'some-pkg/dist/test', // deeper than package top level
    ]
    expect(planSdkDirsToPrune(names)).toEqual([])
  })

  it('leaves non-matching directory names untouched', () => {
    const names = ['some-pkg/lib', 'some-pkg/dist', 'some-pkg/docs', 'some-pkg/testdata']
    expect(planSdkDirsToPrune(names)).toEqual([])
  })

  it('matches scoped package top-level dirs (not @types)', () => {
    const names = ['@google/genai/tests', '@anthropic-ai/sdk/examples', '@types/react/test']
    expect(planSdkDirsToPrune(names)).toEqual(['@google/genai/tests', '@anthropic-ai/sdk/examples'])
  })
})

describe('planRuntimeDocFilesToPrune', () => {
  it('prunes README.md / docs and .d.mts/.d.cts but keeps LICENSE.md & CHANGELOG.md', () => {
    const names = [
      'README.md',
      'README.zh.md',
      'docs.md',
      'index.md',
      'LICENSE.md',
      'LICENCE',
      'CHANGELOG.md',
      'NOTICE.md',
      'license-MIT.md',
      'types.d.mts',
      'types.d.cts',
    ]
    expect(planRuntimeDocFilesToPrune(names)).toEqual([
      'README.md',
      'README.zh.md',
      'docs.md',
      'index.md',
      'types.d.mts',
      'types.d.cts',
    ])
  })

  it('never prunes .mts/.cts source modules or non-md files', () => {
    const names = ['index.mts', 'index.cts', 'index.mjs', 'index.js', 'LICENSE', 'logo.png']
    expect(planRuntimeDocFilesToPrune(names)).toEqual([])
  })
})

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('pruneBundledRuntime', () => {
  it('removes cross-platform sharp, non-host prebuilds and dev files; keeps host + runtime files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-prune-'))
    temps.push(root)
    const nm = path.join(root, 'node_modules')

    // cross-platform sharp variant (host pair + wasm32 kept by planRuntimePrune)
    await mkdir(path.join(nm, '@img', 'sharp-darwin-x64', 'lib'), { recursive: true })
    await writeFile(path.join(nm, '@img', 'sharp-darwin-x64', 'lib', 'x.node'), 'x'.repeat(100))
    await mkdir(path.join(nm, '@img', 'sharp-win32-x64', 'lib'), { recursive: true })
    await writeFile(path.join(nm, '@img', 'sharp-win32-x64', 'lib', 'y.node'), 'y'.repeat(100))
    await mkdir(path.join(nm, '@img', 'sharp-wasm32', 'lib'), { recursive: true })
    await writeFile(path.join(nm, '@img', 'sharp-wasm32', 'lib', 'z.node.wasm'), 'z'.repeat(100))

    // node-pty prebuilds: host kept, arm64 + darwin pruned
    for (const variant of ['win32-x64', 'win32-arm64', 'darwin-x64']) {
      await mkdir(path.join(nm, 'node-pty', 'prebuilds', variant), { recursive: true })
      await writeFile(path.join(nm, 'node-pty', 'prebuilds', variant, 'pty.node'), 'p'.repeat(50))
    }

    // dev files to prune
    await mkdir(path.join(nm, '@google', 'genai', 'dist'), { recursive: true })
    await writeFile(path.join(nm, '@google', 'genai', 'dist', 'index.mjs.map'), 'm'.repeat(30))
    await mkdir(path.join(nm, '@anthropic-ai', 'sdk', 'src'), { recursive: true })
    await writeFile(path.join(nm, '@anthropic-ai', 'sdk', 'src', 'types.d.ts'), 't'.repeat(20))
    // runtime files that must survive
    await writeFile(path.join(nm, '@anthropic-ai', 'sdk', 'src', 'client.ts'), 'c'.repeat(10))
    await mkdir(path.join(nm, 'some-pkg'), { recursive: true })
    await writeFile(path.join(nm, 'some-pkg', 'index.js'), 'j'.repeat(5))

    // SDK dev dir + docs: tests/ and README.md pruned, LICENSE.md kept
    await mkdir(path.join(nm, 'some-pkg', 'tests'), { recursive: true })
    await writeFile(path.join(nm, 'some-pkg', 'tests', 'x.test.js'), 't'.repeat(7))
    await writeFile(path.join(nm, 'some-pkg', 'README.md'), 'r'.repeat(9))
    await writeFile(path.join(nm, 'some-pkg', 'types.d.mts'), 'q'.repeat(13))
    await writeFile(path.join(nm, 'some-pkg', 'LICENSE.md'), 'l'.repeat(11))

    const { removedBytes } = await pruneBundledRuntime(root, 'win32', 'x64')

    // removed: darwin sharp (100) + arm64/darwin prebuilds (100) + map (30) + d.ts (20)
    //          + tests/ dir (7) + README.md (9) + types.d.mts (13) = 279
    expect(removedBytes).toBe(279)
    expect(await pathExists(path.join(nm, '@img', 'sharp-darwin-x64'))).toBe(false)
    expect(await pathExists(path.join(nm, '@img', 'sharp-win32-x64'))).toBe(true)
    expect(await pathExists(path.join(nm, '@img', 'sharp-wasm32'))).toBe(true)
    expect(await pathExists(path.join(nm, 'node-pty', 'prebuilds', 'win32-x64'))).toBe(true)
    expect(await pathExists(path.join(nm, 'node-pty', 'prebuilds', 'win32-arm64'))).toBe(false)
    expect(await pathExists(path.join(nm, '@google', 'genai', 'dist', 'index.mjs.map'))).toBe(false)
    expect(await pathExists(path.join(nm, '@anthropic-ai', 'sdk', 'src', 'types.d.ts'))).toBe(false)
    expect(await pathExists(path.join(nm, '@anthropic-ai', 'sdk', 'src', 'client.ts'))).toBe(true)
    expect(await pathExists(path.join(nm, 'some-pkg', 'index.js'))).toBe(true)
    expect(await pathExists(path.join(nm, 'some-pkg', 'tests'))).toBe(false)
    expect(await pathExists(path.join(nm, 'some-pkg', 'README.md'))).toBe(false)
    expect(await pathExists(path.join(nm, 'some-pkg', 'types.d.mts'))).toBe(false)
    expect(await pathExists(path.join(nm, 'some-pkg', 'LICENSE.md'))).toBe(true)
  })
})

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}
