import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(read('release-manifest.json')) as any

describe('release publication classification contract', () => {
  it('publishes v0.1.5-rc.2 as a guarded replaceable GitHub prerelease', () => {
    expect(manifest.channel).toBe('rc')
    expect(manifest.prerelease).toBe('rc.2')
    expect(manifest.publication.tagTemplate).toBe('v{version}-{prerelease}')
    expect(manifest.publication.githubPrerelease).toBe(true)
    expect(manifest.publication.replaceablePrerelease).toBe(true)
  })

  it('keeps the bundled upstream Runtime pinned to dsh rc.2 independently of client publication channel', () => {
    expect(manifest.runtime.version).toBe('0.1.5-rc.2')
    expect(manifest.runtime.gitTag).toBe('dsh-v0.1.5-rc.2')
    expect(manifest.runtime.gitCommit).toBe('fb2c4b9e698e30edb738bca4cf0618587db7d203')
  })

  it('keeps stable releases permanently non-replaceable in the contract validator', () => {
    const contract = read('scripts/release/contract.mjs')
    expect(contract).toContain("manifest.channel === 'stable'")
    expect(contract).toContain("stable releases cannot move a replaceable prerelease tag")
    expect(contract).toContain("stable releases cannot be GitHub prereleases")
    expect(contract).toContain("replaceablePrerelease requires githubPrerelease=true")
  })

  it('retains guarded replacement logic only for managed prerelease channels', () => {
    const publisher = read('scripts/release/publish-github.mjs')
    expect(publisher).toContain('if (!plan.replaceablePrerelease)')
    expect(publisher).toContain('if (!release)')
    expect(publisher).toContain('if (release.prerelease !== true || release.draft !== false)')
    expect(publisher).toContain("'DELETE', `repos/${repository}/releases/${release.id}`")
    expect(publisher).toContain("'DELETE', `repos/${repository}/git/refs/tags/${releaseTag}`")
    expect(publisher).toContain('if (publishedTagSha !== releaseSha)')
    expect(publisher).toContain('published asset set differs from contract')
  })
})
