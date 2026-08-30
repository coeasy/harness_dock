import { describe, expect, it, vi } from 'vitest'
import { applyPlannedRuntimeUpdate } from '../src/runtime-update.ts'
import type { PlannedDelivery, ReleaseManifestV2 } from '../src/update-orchestrator.ts'

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

const manifest: ReleaseManifestV2 = {
  schemaVersion: 2,
  generatedAt: '2026-08-30T00:00:00.000Z',
  release: { version: '0.2.0', channel: 'stable', tag: 'v0.2.0' },
  source: { provider: 'github', repository: 'coeasy/harness_dock' },
  artifacts: [],
}

function deltaDelivery(): PlannedDelivery {
  return {
    mode: 'delta',
    artifact: {
      id: 'runtime-win',
      component: 'runtime',
      version: '0.1.3',
      channel: 'stable',
      platform: 'win32',
      arch: 'x64',
      format: 'tar.gz',
      assetName: 'HarnessDock-runtime-0.1.3-win32-x64.tar.gz',
      url: 'https://example.invalid/runtime.tar.gz',
      sha256: hashA,
      size: 100,
    },
    delta: {
      fromVersion: '0.1.2',
      assetName: 'HarnessDock-runtime-delta-0.1.2_to_0.1.3-win32-x64.tar.gz',
      url: 'https://example.invalid/delta.tar.gz',
      sha256: hashB,
      size: 20,
      format: 'runtime-overlay-tar.gz',
    },
  }
}

describe('runtime update manager', () => {
  it('commits a valid delta without downloading the full Runtime', async () => {
    const installDelta = vi.fn(async () => undefined)
    const installFull = vi.fn(async () => undefined)

    const result = await applyPlannedRuntimeUpdate({
      manifest,
      delivery: deltaDelivery(),
      runtimeDir: 'C:/runtime',
      platform: 'win32',
      arch: 'x64',
      installDelta,
      installFull,
    })

    expect(result).toEqual({ targetVersion: '0.1.3', delivery: 'delta', fellBackFromDelta: false })
    expect(installDelta).toHaveBeenCalledOnce()
    expect(installFull).not.toHaveBeenCalled()
  })

  it('automatically falls back to the canonical full Runtime if delta application fails', async () => {
    const installDelta = vi.fn(async () => {
      throw new Error('base tree mismatch')
    })
    const installFull = vi.fn(async () => undefined)
    const log = vi.fn()

    const result = await applyPlannedRuntimeUpdate({
      manifest,
      delivery: deltaDelivery(),
      runtimeDir: 'C:/runtime',
      platform: 'win32',
      arch: 'x64',
      installDelta,
      installFull,
      log,
    })

    expect(result).toEqual({ targetVersion: '0.1.3', delivery: 'full', fellBackFromDelta: true })
    expect(installDelta).toHaveBeenCalledOnce()
    expect(installFull).toHaveBeenCalledOnce()
    expect(log.mock.calls.flat().join(' ')).toMatch(/falling back to full Runtime/)
  })

  it('rejects an artifact for a different platform before touching the Runtime', async () => {
    const installDelta = vi.fn(async () => undefined)
    const installFull = vi.fn(async () => undefined)
    await expect(
      applyPlannedRuntimeUpdate({
        manifest,
        delivery: deltaDelivery(),
        runtimeDir: '/runtime',
        platform: 'linux',
        arch: 'x64',
        installDelta,
        installFull,
      }),
    ).rejects.toThrow(/does not match host/)
    expect(installDelta).not.toHaveBeenCalled()
    expect(installFull).not.toHaveBeenCalled()
  })
})
