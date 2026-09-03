import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('v0.2.0 Round 2 immutable Runtime image', () => {
  it('seals the final post-pruning payload with a deterministic content identity', () => {
    const identity = read('packages/client-runtime/src/image-identity.ts')
    const finalPrune = read('packages/client-runtime/src/prune-node-cli.ts')

    expect(identity).toContain("IDENTITY_ALGORITHM = 'sha256-v1'")
    expect(identity).toContain("EXCLUDED_ROOT_FILES = new Set(['manifest.json', '.ready'])")
    expect(identity).toContain("imageIdentity: `sha256:${hash.digest('hex')}`")
    expect(finalPrune).toContain('computeRuntimeImageIdentity(dest)')
    expect(finalPrune).toContain('manifest.imageIdentity = identity.imageIdentity')
    expect(finalPrune).toContain('manifest.contentFileCount = identity.contentFileCount')
    expect(finalPrune).toContain('manifest.contentBytes = identity.contentBytes')
  })

  it('binds the sealed manifest to client/upstream/build identities and zero-download policy', () => {
    const finalPrune = read('packages/client-runtime/src/prune-node-cli.ts')

    expect(finalPrune).toContain('manifest.schemaVersion = 1')
    expect(finalPrune).toContain('manifest.clientVersion')
    expect(finalPrune).toContain('manifest.dshGitTag = manifest.gitTag')
    expect(finalPrune).toContain('manifest.dshGitCommit = manifest.gitCommit')
    expect(finalPrune).toContain('manifest.buildCommit')
    expect(finalPrune).toContain('manifest.nodeDistributionPruned = true')
    expect(finalPrune).toContain('manifest.productionClosurePrunedBytes')
    expect(finalPrune).toContain('manifest.firstLaunchRuntimeDownloadRequired = false')
  })

  it('rejects payload drift both when installing a bundle and before smoke boot', () => {
    const bundle = read('packages/client-runtime/src/runtime-bundle.ts')
    const smoke = read('packages/client-runtime/src/smoke-cli.ts')

    expect(bundle).toContain('assertRuntimeImageIdentity(input.runtimeDir, manifest)')
    expect(smoke).toContain('await assertRuntimeImageIdentity(runtimeDir, manifest)')
    expect(smoke.indexOf('await assertRuntimeImageIdentity(runtimeDir, manifest)')).toBeLessThan(
      smoke.indexOf("if (manifest.platform !== process.platform || manifest.arch !== process.arch)"),
    )
  })

  it('keeps the final architecture explicit that the desktop Runtime is immutable and embedded', () => {
    const architecture = read('docs/v0.2.0-architecture-five-round-final.md')

    expect(architecture).toContain('Immutable Embedded Runtime')
    expect(architecture).toContain('首次启动不下载 Node 或 dsh')
    expect(architecture).toContain('Runtime manifest/image identity/hash')
  })
})
