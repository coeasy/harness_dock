import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InvalidRuntimeManifestError,
  RuntimeArtifactIntegrityError,
  RuntimeRollbackUnavailableError,
  RuntimeUpdateManager,
  normalizeRuntimeReleaseManifest,
  type RuntimeReleaseFile,
  type RuntimeReleaseManifest,
} from '../src/runtime-update.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-runtime-update-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function descriptor(filePath: string, content: string, url: string): RuntimeReleaseFile {
  return {
    path: filePath,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
    url,
  }
}

function manifest(version: string, files: RuntimeReleaseFile[]): RuntimeReleaseManifest {
  return {
    schemaVersion: 2,
    runtime: 'dsh',
    version,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 2,
    files,
  }
}

describe('RuntimeUpdateManager', () => {
  it('reuses unchanged files, downloads changed files, activates atomically and rolls back', async () => {
    const root = await tempRoot()
    const payloads = new Map([
      ['memory://node-v1', 'node-stable'],
      ['memory://dsh-v1', 'dsh-v1'],
      ['memory://dsh-v2', 'dsh-v2'],
    ])
    const fetchFile = vi.fn(async (file: RuntimeReleaseFile, destination: string) => {
      const content = payloads.get(file.url)
      if (content === undefined) throw new Error(`missing fixture ${file.url}`)
      await writeFile(destination, content, 'utf8')
    })
    const manager = new RuntimeUpdateManager({
      root,
      fetchFile,
      now: () => new Date('2026-08-30T06:00:00.000Z'),
    })

    const v1 = manifest('0.1.1', [
      descriptor('bin/node', 'node-stable', 'memory://node-v1'),
      descriptor('lib/dsh.js', 'dsh-v1', 'memory://dsh-v1'),
    ])
    const preparedV1 = await manager.prepare(v1)
    expect(preparedV1).toMatchObject({ reusedFiles: 0, downloadedFiles: 2 })
    await manager.activate('0.1.1')
    expect(await manager.activeDirectory()).toBe(manager.versionDirectory('0.1.1'))

    fetchFile.mockClear()
    const v2 = manifest('0.1.2', [
      descriptor('bin/node', 'node-stable', 'memory://node-v1'),
      descriptor('lib/dsh.js', 'dsh-v2', 'memory://dsh-v2'),
    ])
    const preparedV2 = await manager.prepare(v2)
    expect(preparedV2).toMatchObject({
      reusedFiles: 1,
      downloadedFiles: 1,
      reusedBytes: Buffer.byteLength('node-stable'),
      downloadedBytes: Buffer.byteLength('dsh-v2'),
    })
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(fetchFile.mock.calls[0]?.[0].url).toBe('memory://dsh-v2')

    const activated = await manager.activate('0.1.2')
    expect(activated.current?.version).toBe('0.1.2')
    expect(activated.previous?.version).toBe('0.1.1')
    expect(
      await readFile(path.join(manager.versionDirectory('0.1.2'), 'lib', 'dsh.js'), 'utf8'),
    ).toBe('dsh-v2')

    const rolledBack = await manager.rollback()
    expect(rolledBack.current?.version).toBe('0.1.1')
    expect(rolledBack.previous?.version).toBe('0.1.2')
  })

  it('never publishes a runtime whose downloaded file fails SHA256 verification', async () => {
    const root = await tempRoot()
    const target = manifest('0.2.0', [descriptor('bin/dsh', 'expected', 'memory://bad')])
    const manager = new RuntimeUpdateManager({
      root,
      fetchFile: async (_file, destination) => writeFile(destination, 'tampered', 'utf8'),
    })

    await expect(manager.prepare(target)).rejects.toBeInstanceOf(RuntimeArtifactIntegrityError)
    expect(await manager.readInstallMetadata('0.2.0')).toBeNull()
    const versions = await readdir(path.join(root, 'versions')).catch(() => [])
    expect(versions.some((name) => name.includes('staging'))).toBe(false)
  })

  it('rejects path traversal, absolute-like paths, duplicates and target mismatches', async () => {
    const good = descriptor('bin/dsh', 'dsh', 'memory://dsh')
    expect(() =>
      normalizeRuntimeReleaseManifest(manifest('0.2.0', [{ ...good, path: '../escape' }])),
    ).toThrow(InvalidRuntimeManifestError)
    expect(() =>
      normalizeRuntimeReleaseManifest(manifest('0.2.0', [{ ...good, path: '/absolute' }])),
    ).toThrow(InvalidRuntimeManifestError)
    expect(() =>
      normalizeRuntimeReleaseManifest(
        manifest('0.2.0', [good, { ...good, url: 'memory://duplicate' }]),
      ),
    ).toThrow(InvalidRuntimeManifestError)

    const root = await tempRoot()
    const manager = new RuntimeUpdateManager({
      root,
      platform: process.platform,
      arch: 'definitely-not-this-arch',
      fetchFile: async () => undefined,
    })
    await expect(manager.prepare(manifest('0.2.0', [good]))).rejects.toBeInstanceOf(
      InvalidRuntimeManifestError,
    )
  })

  it('fails rollback clearly when no previous activated version exists', async () => {
    const root = await tempRoot()
    const manager = new RuntimeUpdateManager({ root, fetchFile: async () => undefined })
    await expect(manager.rollback()).rejects.toBeInstanceOf(RuntimeRollbackUnavailableError)
  })
})
