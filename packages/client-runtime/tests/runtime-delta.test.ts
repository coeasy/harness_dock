import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRuntimeOverlay,
  readRuntimeDeltaManifest,
  runtimeTreeDigest,
} from '../src/runtime-delta.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-runtime-delta-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime overlay delta', () => {
  it('applies changed/new/deleted files and reaches the target tree digest', async () => {
    const root = await tempRoot()
    const base = path.join(root, 'base')
    const expected = path.join(root, 'expected')
    const staging = path.join(root, 'staging')
    const overlay = path.join(root, 'overlay')

    await mkdir(path.join(base, 'nested'), { recursive: true })
    await writeFile(path.join(base, 'keep.txt'), 'same\n')
    await writeFile(path.join(base, 'change.txt'), 'old\n')
    await writeFile(path.join(base, 'delete.txt'), 'remove\n')
    await writeFile(path.join(base, 'nested', 'value.txt'), 'nested\n')
    await writeFile(path.join(base, '.ready'), 'ephemeral')

    await cp(base, expected, { recursive: true })
    await writeFile(path.join(expected, 'change.txt'), 'new\n')
    await rm(path.join(expected, 'delete.txt'))
    await writeFile(path.join(expected, 'added.txt'), 'added\n')
    await writeFile(path.join(expected, '.ready'), 'different ephemeral marker')

    await cp(base, staging, { recursive: true })
    await mkdir(overlay, { recursive: true })
    await writeFile(path.join(overlay, 'change.txt'), 'new\n')
    await writeFile(path.join(overlay, 'added.txt'), 'added\n')

    const baseDigest = await runtimeTreeDigest(base)
    expect(baseDigest).not.toBe(await runtimeTreeDigest(expected))

    await applyRuntimeOverlay({
      stagingDir: staging,
      overlayDir: overlay,
      deletePaths: ['delete.txt'],
    })

    expect(await readFile(path.join(staging, 'change.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(path.join(staging, 'added.txt'), 'utf8')).toBe('added\n')
    expect(await runtimeTreeDigest(staging)).toBe(await runtimeTreeDigest(expected))
  })

  it('excludes the ephemeral .ready marker from the runtime tree identity', async () => {
    const root = await tempRoot()
    const left = path.join(root, 'left')
    const right = path.join(root, 'right')
    await mkdir(left)
    await mkdir(right)
    await writeFile(path.join(left, 'file.txt'), 'same')
    await writeFile(path.join(right, 'file.txt'), 'same')
    await writeFile(path.join(left, '.ready'), 'old')
    await writeFile(path.join(right, '.ready'), 'new')
    expect(await runtimeTreeDigest(left)).toBe(await runtimeTreeDigest(right))
  })

  it('rejects path traversal in the delta deletion manifest', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'delta-manifest.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        fromVersion: '0.1.2',
        toVersion: '0.1.3',
        platform: 'linux',
        arch: 'x64',
        fromTreeSha256: 'a'.repeat(64),
        toTreeSha256: 'b'.repeat(64),
        delete: ['../outside'],
      }),
    )
    await expect(readRuntimeDeltaManifest(file)).rejects.toThrow(/unsafe runtime delta path/)
  })
})
