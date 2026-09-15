import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundledDshBin,
  bundledNodeRel,
  bundledRuntimeVersion,
  canCopyHostNode,
  inspectBundledRuntime,
  NODE_BUNDLE_VERSION,
  nodeOfficialUrl,
} from '../src/bundled.ts'

const require = createRequire(import.meta.url)
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('nodeOfficialUrl', () => {
  it('points at an official Node ZIP for Windows x64', () => {
    expect(nodeOfficialUrl(NODE_BUNDLE_VERSION, 'win32', 'x64')).toEqual({
      url: `https://nodejs.org/dist/v${NODE_BUNDLE_VERSION}/node-v${NODE_BUNDLE_VERSION}-win-x64.zip`,
      kind: 'zip',
      nodeRel: 'node.exe',
    })
  })

  it('can build npmmirror URLs', () => {
    expect(
      nodeOfficialUrl(NODE_BUNDLE_VERSION, 'win32', 'x64', 'https://npmmirror.com/mirrors/node')
        .url,
    ).toBe(`https://npmmirror.com/mirrors/node/v${NODE_BUNDLE_VERSION}/node-v${NODE_BUNDLE_VERSION}-win-x64.zip`)
  })

  it('points at official tarballs for macOS and Linux', () => {
    expect(nodeOfficialUrl(NODE_BUNDLE_VERSION, 'darwin', 'arm64').url).toContain(
      'darwin-arm64.tar.gz',
    )
    expect(nodeOfficialUrl(NODE_BUNDLE_VERSION, 'linux', 'x64').url).toContain('linux-x64.tar.xz')
  })
})

describe('inspectBundledRuntime', () => {
  it('returns node + dsh bin when the full layout exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bundle-'))
    temps.push(dir)
    const nodeRel = bundledNodeRel('win32')
    const dshRel = bundledDshBin(dir)
    mkdirSync(path.dirname(path.join(dir, nodeRel)), { recursive: true })
    mkdirSync(path.dirname(dshRel), { recursive: true })
    writeFileSync(path.join(dir, nodeRel), '')
    writeFileSync(dshRel, '')
    expect(inspectBundledRuntime(dir, 'win32')).toEqual({
      nodeBin: path.join(dir, 'node.exe'),
      dshBin: dshRel,
    })
  })

  it('returns null when node or dsh is missing', () => {
    expect(inspectBundledRuntime('/missing-runtime', 'linux')).toBeNull()
  })
})

describe('canCopyHostNode', () => {
  it('allows copying the host Node binary when targeting the same OS', () => {
    expect(
      canCopyHostNode({ hostPlatform: 'win32', targetPlatform: 'win32' }),
    ).toBe(true)
    expect(
      canCopyHostNode({
        hostPlatform: 'win32',
        targetPlatform: 'linux',
      }),
    ).toBe(false)
  })
})

describe('NODE_BUNDLE_VERSION consistency', () => {
  it('matches the node version single source of truth in scripts/versions.json', () => {
    const { node } = require('../../../scripts/versions.json')
    expect(NODE_BUNDLE_VERSION).toBe(node)
  })
})

describe('bundledRuntimeVersion', () => {
  it('reads the version from manifest.json when present', () => {
    const read = (filePath: string) => {
      if (filePath.endsWith('manifest.json')) return '{"dshVersion":"9.9.9","nodeVersion":"22.19.0"}'
      throw new Error(`unexpected read: ${filePath}`)
    }
    expect(bundledRuntimeVersion('/some/root', read)).toBe('9.9.9')
  })

  it('falls back to the vendored dsh package.json when there is no manifest', () => {
    const read = (filePath: string) => {
      if (filePath.endsWith(path.join('@deepseek-ai', 'dsh', 'package.json'))) {
        return '{"name":"@deepseek-ai/dsh","version":"0.1.1-rc.2"}'
      }
      throw new Error(`unexpected read: ${filePath}`)
    }
    expect(bundledRuntimeVersion('/some/root', read)).toBe('0.1.1-rc.2')
  })

  it('returns null when nothing version-bearing exists', () => {
    const read = () => {
      throw new Error('missing')
    }
    expect(bundledRuntimeVersion('/some/root', read)).toBeNull()
  })
})
