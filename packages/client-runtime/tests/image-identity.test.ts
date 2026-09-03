import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRuntimeImageIdentity, computeRuntimeImageIdentity } from '../src/image-identity.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-image-'))
  roots.push(root)
  await mkdir(path.join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  await writeFile(path.join(root, 'node.exe'), 'node-binary')
  await writeFile(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"version":"1.2.3"}')
  return root
}

describe('runtime image identity', () => {
  it('is deterministic and excludes mutable root metadata files', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'manifest.json'), '{"preparedAt":"old"}')
    await writeFile(path.join(root, '.ready'), 'old')
    const first = await computeRuntimeImageIdentity(root)

    await writeFile(path.join(root, 'manifest.json'), '{"preparedAt":"new"}')
    await writeFile(path.join(root, '.ready'), 'new')
    const second = await computeRuntimeImageIdentity(root)

    expect(second).toEqual(first)
  })

  it('detects content changes and enforces the recorded size budget', async () => {
    const root = await fixture()
    const identity = await computeRuntimeImageIdentity(root)
    const manifest = {
      imageIdentityAlgorithm: identity.algorithm,
      imageIdentity: identity.imageIdentity,
      contentFileCount: identity.contentFileCount,
      contentBytes: identity.contentBytes,
      runtimeSizeBudgetBytes: identity.contentBytes,
    }
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest))
    await expect(assertRuntimeImageIdentity(root)).resolves.toEqual(identity)

    await writeFile(path.join(root, 'node.exe'), 'node-binary-mutated')
    await expect(assertRuntimeImageIdentity(root)).rejects.toThrow('runtime image identity mismatch')
  })
})
