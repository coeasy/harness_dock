import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  createUpdatePlan,
  createUpdateTransaction,
  githubLatestReleaseManifestUrl,
  resolveReleaseArtifactUrl,
  selectDelivery,
  transitionUpdateTransaction,
  type ReleaseArtifactV2,
  type ReleaseManifestV2,
} from '../src/update-orchestrator.ts'

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
const hashC = 'c'.repeat(64)

function manifest(artifacts: ReleaseArtifactV2[]): ReleaseManifestV2 {
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-30T00:00:00.000Z',
    release: { version: '0.2.0', channel: 'stable', tag: 'v0.2.0' },
    source: { provider: 'github', repository: 'coeasy/harness_dock' },
    artifacts,
  }
}

describe('update orchestrator', () => {
  it('selects the preferred host package and a smaller matching delta', () => {
    const result = createUpdatePlan(
      manifest([
        {
          id: 'electron-win-full-zip',
          component: 'host',
          version: '0.2.0',
          channel: 'stable',
          host: 'electron',
          runtimeMode: 'full',
          platform: 'win32',
          arch: 'x64',
          format: 'zip',
          assetName: 'HarnessDock-0.2.0-win-x64-full.zip',
          sha256: hashA,
          size: 150,
        },
        {
          id: 'electron-win-full-nsis',
          component: 'host',
          version: '0.2.0',
          channel: 'stable',
          host: 'electron',
          runtimeMode: 'full',
          platform: 'win32',
          arch: 'x64',
          format: 'nsis',
          assetName: 'HarnessDock-Setup-0.2.0-win-x64-full.exe',
          sha256: hashB,
          size: 140,
          deltas: [
            {
              fromVersion: '0.1.1',
              fromSha256: hashC,
              assetName: 'HarnessDock-Setup-0.1.1_to_0.2.0.blockmap',
              sha256: hashA,
              size: 22,
              format: 'blockmap',
            },
          ],
        },
      ]),
      {
        host: 'electron',
        hostVersion: '0.1.1',
        hostSha256: hashC,
        runtimeVersion: '0.1.2-alpha.1',
        runtimeMode: 'full',
        platform: 'win32',
        arch: 'x64',
        channel: 'stable',
      },
    )

    expect(result?.host?.artifact.format).toBe('nsis')
    expect(result?.host?.mode).toBe('delta')
    expect(result?.restart).toBe('app')
    expect(result?.targetHostVersion).toBe('0.2.0')
  })

  it('plans an independent runtime-only update for a managed Thin runtime', () => {
    const result = createUpdatePlan(
      manifest([
        {
          id: 'runtime-win-x64',
          component: 'runtime',
          version: '0.1.3',
          channel: 'stable',
          platform: 'win32',
          arch: 'x64',
          format: 'tar.gz',
          assetName: 'HarnessDock-runtime-0.1.3-win32-x64.tar.gz',
          sha256: hashA,
          size: 80,
        },
      ]),
      {
        host: 'electron',
        hostVersion: '0.2.0',
        runtimeVersion: '0.1.2-alpha.1',
        runtimeMode: 'thin',
        platform: 'win32',
        arch: 'x64',
        channel: 'stable',
      },
    )

    expect(result?.host).toBeUndefined()
    expect(result?.runtime?.mode).toBe('full')
    expect(result?.restart).toBe('runtime')
    expect(result?.targetRuntimeVersion).toBe('0.1.3')
  })

  it('does not mutate the signed bundled Runtime of a Full install independently by default', () => {
    const result = createUpdatePlan(
      manifest([
        {
          id: 'runtime-win-x64',
          component: 'runtime',
          version: '0.1.3',
          channel: 'stable',
          platform: 'win32',
          arch: 'x64',
          format: 'tar.gz',
          assetName: 'HarnessDock-runtime-0.1.3-win32-x64.tar.gz',
          sha256: hashA,
          size: 80,
        },
      ]),
      {
        host: 'electron',
        hostVersion: '0.2.0',
        runtimeVersion: '0.1.2-alpha.1',
        runtimeMode: 'full',
        platform: 'win32',
        arch: 'x64',
        channel: 'stable',
      },
    )

    expect(result).toBeNull()
  })

  it('does not cross update channels', () => {
    const result = createUpdatePlan(
      manifest([
        {
          id: 'beta-host',
          component: 'host',
          version: '0.2.0-beta.1',
          channel: 'beta',
          host: 'electron',
          runtimeMode: 'thin',
          platform: 'win32',
          arch: 'x64',
          format: 'nsis',
          assetName: 'beta.exe',
          sha256: hashA,
          size: 100,
        },
      ]),
      {
        host: 'electron',
        hostVersion: '0.1.1',
        runtimeVersion: '0.1.2-alpha.1',
        runtimeMode: 'thin',
        platform: 'win32',
        arch: 'x64',
        channel: 'stable',
      },
    )

    expect(result).toBeNull()
  })

  it('falls back to the full artifact when a delta is not smaller or does not match', () => {
    const artifact: ReleaseArtifactV2 = {
      id: 'runtime',
      component: 'runtime',
      version: '0.1.3',
      channel: 'stable',
      platform: 'linux',
      arch: 'x64',
      format: 'tar.gz',
      assetName: 'runtime.tar.gz',
      sha256: hashA,
      size: 50,
      deltas: [
        {
          fromVersion: '0.1.2',
          assetName: 'too-large.patch',
          sha256: hashB,
          size: 60,
          format: 'runtime-overlay-tar.gz',
        },
      ],
    }

    expect(selectDelivery(artifact, '0.1.2').mode).toBe('full')
  })

  it('requires the installed digest when a delta declares fromSha256', () => {
    const artifact: ReleaseArtifactV2 = {
      id: 'host',
      component: 'host',
      version: '0.2.0',
      channel: 'stable',
      host: 'electron',
      runtimeMode: 'thin',
      platform: 'win32',
      arch: 'x64',
      format: 'nsis',
      assetName: 'setup.exe',
      sha256: hashA,
      size: 100,
      deltas: [
        {
          fromVersion: '0.1.1',
          fromSha256: hashC,
          assetName: 'setup.blockmap',
          sha256: hashB,
          size: 20,
          format: 'blockmap',
        },
      ],
    }

    expect(selectDelivery(artifact, '0.1.1').mode).toBe('full')
    expect(selectDelivery(artifact, '0.1.1', hashB).mode).toBe('full')
    expect(selectDelivery(artifact, '0.1.1', hashC).mode).toBe('delta')
  })

  it('resolves the latest GitHub manifest and artifact URL without filename guessing', () => {
    const data = manifest([])
    expect(githubLatestReleaseManifestUrl('coeasy/harness_dock')).toBe(
      'https://github.com/coeasy/harness_dock/releases/latest/download/release-manifest.json',
    )
    expect(
      resolveReleaseArtifactUrl(data, {
        assetName: 'HarnessDock-Setup-0.2.0-win-x64-full.exe',
      }),
    ).toBe(
      'https://github.com/coeasy/harness_dock/releases/download/v0.2.0/HarnessDock-Setup-0.2.0-win-x64-full.exe',
    )
  })

  it('orders stable and prerelease versions correctly', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.3')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0-beta.10', '0.2.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.1', '0.2.0')).toBeGreaterThan(0)
  })

  it('enforces update transaction transitions', () => {
    const plan = createUpdatePlan(
      manifest([
        {
          id: 'host',
          component: 'host',
          version: '0.2.0',
          channel: 'stable',
          host: 'electron',
          runtimeMode: 'thin',
          platform: 'win32',
          arch: 'x64',
          format: 'nsis',
          assetName: 'setup.exe',
          sha256: hashA,
          size: 100,
        },
      ]),
      {
        host: 'electron',
        hostVersion: '0.1.1',
        runtimeVersion: '0.1.2-alpha.1',
        runtimeMode: 'thin',
        platform: 'win32',
        arch: 'x64',
        channel: 'stable',
      },
    )

    if (!plan) throw new Error('expected plan')
    const transaction = createUpdateTransaction(plan, {
      id: 'tx-1',
      now: new Date('2026-08-30T00:00:00.000Z'),
    })
    const downloading = transitionUpdateTransaction(transaction, 'downloading')
    const staged = transitionUpdateTransaction(downloading, 'staged')
    expect(staged.phase).toBe('staged')
    expect(() => transitionUpdateTransaction(staged, 'succeeded')).toThrow(/invalid update transition/)
  })
})
