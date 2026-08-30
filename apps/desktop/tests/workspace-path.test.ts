import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalDestinationPath } from '../src/workspace-path.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace destination boundary', () => {
  it('accepts not-yet-created directories below the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hd-workspace-'))
    roots.push(root)
    const canonicalRoot = await realpath(root)
    await expect(canonicalDestinationPath(path.join(root, 'new', 'nested', 'file.bin'), root))
      .resolves.toBe(path.join(canonicalRoot, 'new', 'nested', 'file.bin'))
  })

  it('rejects a symlinked parent that resolves outside the workspace before mkdir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hd-workspace-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'hd-outside-'))
    roots.push(root, outside)
    await mkdir(path.join(root, 'safe'), { recursive: true })
    await symlink(outside, path.join(root, 'safe', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(canonicalDestinationPath(path.join(root, 'safe', 'escape', 'new', 'file.bin'), root))
      .rejects.toThrow('outside the allowed workspace boundary')
  })
})
