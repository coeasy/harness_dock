import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(read('release-manifest.json')) as any

describe('replaceable prerelease publication contract', () => {
  it('allows the current RC tag to be reissued only as a GitHub prerelease', () => {
    expect(manifest.channel).toBe('rc')
    expect(manifest.publication.githubPrerelease).toBe(true)
    expect(manifest.publication.replaceablePrerelease).toBe(true)
  })

  it('keeps stable releases permanently non-replaceable in the contract validator', () => {
    const contract = read('scripts/release/contract.mjs')
    expect(contract).toContain("manifest.channel === 'stable'")
    expect(contract).toContain("stable releases cannot move a replaceable prerelease tag")
    expect(contract).toContain("replaceablePrerelease requires githubPrerelease=true")
  })

  it('replaces only an existing managed published prerelease and re-verifies the new tag and assets', () => {
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
