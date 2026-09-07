import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('Windows one-click bundle contract', () => {
  it('packages NSIS only and leaves MSI/WiX to the release workflow', () => {
    const build = readFileSync(path.join(repoRoot, 'scripts', 'build.mjs'), 'utf8')

    expect(build).toContain("process.platform === 'win32'")
    expect(build).toContain("tauriBuildArgs.push('--bundles', 'nsis')")
    expect(build).toContain('MSI/WiX is release-workflow owned')
  })
})
