import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repairKnownRuntimeAssets } from '../src/integrity.ts'

describe('runtime integrity permission repair', () => {
  it.skipIf(process.platform === 'win32')('restores the Linux Landlock helper executable bit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-integrity-'))
    const helper = path.join(
      root,
      'node_modules',
      '@deepseek-ai',
      'node-addon-landlock-run-linux-x64',
      'bin',
      'landlock-run',
    )
    await mkdir(path.dirname(helper), { recursive: true })
    await writeFile(helper, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(helper, 0o644)

    const repaired = await repairKnownRuntimeAssets(root)
    const mode = (await stat(helper)).mode

    expect(mode & 0o111).not.toBe(0)
    expect(repaired.some((entry) => entry.includes('node-addon-landlock-run-linux-x64'))).toBe(true)
  })
})
