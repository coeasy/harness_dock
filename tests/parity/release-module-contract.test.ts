import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(read('release-manifest.json')) as any

describe('platform-aware release module', () => {
  it('keeps release policy in a versioned manifest rather than the workflow', () => {
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.publication.candidateWorkflow).toBe('.github/workflows/tauri-candidate.yml')
    expect(manifest.publication.requiredSameShaWorkflows).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/windows-packaged-startup.yml',
    ])
    expect(manifest.checksums).toEqual({ algorithm: 'sha256', file: 'SHA256SUMS' })
  })

  it('models desktop platform and architecture differences explicitly', () => {
    expect(manifest.targets['windows-x64']).toMatchObject({
      platform: 'win32',
      arch: 'x64',
      runtimeMode: 'sealed-local',
      runtimeKey: 'win32-x64',
      candidateArtifact: 'tauri-desktop-win-x64',
      startupGate: 'installed',
    })
    expect(manifest.targets['windows-x64'].assets.map((asset: any) => asset.match)).toEqual(['*setup.exe'])

    expect(manifest.targets['linux-x64']).toMatchObject({
      platform: 'linux',
      arch: 'x64',
      runtimeMode: 'sealed-local',
      runtimeKey: 'linux-x64',
      candidateArtifact: 'tauri-desktop-linux-x64',
    })
    expect(manifest.targets['linux-x64'].assets.map((asset: any) => asset.match)).toEqual(['*.deb', '*.AppImage'])

    expect(manifest.targets['macos-x64']).toMatchObject({
      platform: 'darwin',
      arch: 'x64',
      runtimeKey: 'darwin-x64',
      candidateArtifact: 'tauri-desktop-mac-x64',
    })
    expect(manifest.targets['macos-arm64']).toMatchObject({
      platform: 'darwin',
      arch: 'arm64',
      runtimeKey: 'darwin-arm64',
      candidateArtifact: 'tauri-desktop-mac-arm64',
    })
  })

  it('keeps mobile release targets remote-gateway only', () => {
    for (const id of ['android-arm64', 'ios-arm64-simulator']) {
      expect(manifest.targets[id].runtimeMode).toBe('remote-gateway')
      expect(manifest.targets[id].runtimeKey).toBeUndefined()
    }
    expect(manifest.targets['android-arm64'].assets.map((asset: any) => asset.match)).toEqual(['*.apk', '*.aab'])
    expect(manifest.targets['ios-arm64-simulator'].assets.map((asset: any) => asset.match)).toEqual(['*.zip'])
  })

  it('publishes one Runtime bundle for every sealed desktop Runtime identity', () => {
    expect(Object.keys(manifest.runtimeBundles).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ])
    for (const target of Object.values(manifest.targets) as any[]) {
      if (target.runtimeMode !== 'sealed-local') continue
      const runtime = manifest.runtimeBundles[target.runtimeKey]
      expect(runtime).toBeTruthy()
      expect(runtime.platform).toBe(target.platform)
      expect(runtime.arch).toBe(target.arch)
    }
  })

  it('derives the current 15-file beta contract instead of hard-coding it in YAML', () => {
    const clientAssetCount = Object.values(manifest.targets).reduce(
      (total: number, target: any) => total + target.assets.length,
      0,
    )
    const runtimeAssetCount = Object.keys(manifest.runtimeBundles).length
    expect(clientAssetCount).toBe(10)
    expect(runtimeAssetCount).toBe(4)
    expect(clientAssetCount + runtimeAssetCount + 1).toBe(15)

    const workflow = read('.github/workflows/release.yml')
    expect(workflow).not.toContain('expected 15')
    expect(workflow).not.toContain('copy_one()')
    expect(workflow).not.toContain('pack_runtime()')
  })

  it('splits release validation, assembly, and publication into independent jobs', () => {
    const workflow = read('.github/workflows/release.yml')
    expect(workflow).toContain('\n  validate:')
    expect(workflow).toContain('\n  assemble:')
    expect(workflow).toContain('\n  publish:')
    expect(workflow).toContain('node scripts/check-release.mjs')
    expect(workflow).toContain('node scripts/release/assemble.mjs release-input release-assets')
    expect(workflow).toContain('node scripts/release/verify-assets.mjs release-assets')
    expect(workflow).toContain('node scripts/release/publish-github.mjs release-assets')
    expect(workflow).toContain('harnessdock-release-assets-${{ needs.validate.outputs.sha }}')
  })

  it('keeps release scripts syntactically valid and the manifest contract executable', () => {
    for (const relative of [
      'scripts/release/contract.mjs',
      'scripts/release/assemble.mjs',
      'scripts/release/verify-assets.mjs',
      'scripts/release/publish-github.mjs',
      'scripts/check-release.mjs',
    ]) {
      const result = spawnSync(process.execPath, ['--check', path.join(repoRoot, relative)], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }

    const contract = spawnSync(process.execPath, ['scripts/release/contract.mjs', 'validate'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(contract.status, contract.stderr).toBe(0)
    expect(contract.stdout).toContain('release contract OK: v0.1.2, 15 assets')
  })

  it('ties release validation to the same desktop target source of truth', () => {
    const check = read('scripts/check-release.mjs')
    expect(check).toContain("from './build-targets.mjs'")
    expect(check).toContain("from './release/contract.mjs'")
    expect(check).toContain('DESKTOP_BUILD_TARGETS')
    expect(check).toContain("target.runtimeMode !== 'remote-gateway'")
  })
})
