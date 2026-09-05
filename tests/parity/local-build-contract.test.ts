import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('self-contained local client build', () => {
  it('bootstraps a verified build-time Node on bare Windows machines', () => {
    const batch = read('scripts/build.bat')
    const bootstrap = read('scripts/bootstrap-node.ps1')

    expect(batch).toContain('bootstrap-node.ps1')
    expect(batch).toContain('node scripts\\bootstrap.mjs')
    expect(batch).toContain('node scripts\\build.mjs --skip-install')
    expect(bootstrap).toContain('SHASUMS256.txt')
    expect(bootstrap).toContain('Get-FileHash -Algorithm SHA256')
    expect(bootstrap).toContain(".local-tools")
  })

  it('prepares the exact sealed runtime instead of assuming resources/dsh-runtime exists', () => {
    const prepare = read('scripts/prepare-local-runtime.mjs')
    const build = read('scripts/build.mjs')

    expect(prepare).toContain("origin.gitTag")
    expect(prepare).toContain("origin.gitCommit")
    expect(prepare).toContain('expectedReleaseDigest')
    expect(prepare).toContain("'clone'")
    expect(prepare).toContain("'build:official'")
    expect(prepare).toContain('DSH_PACKED_RUNTIME_DIR')
    expect(prepare).toContain("runtimeEmbedded === true")
    expect(prepare).toContain("firstLaunchRuntimeDownloadRequired === false")

    expect(build).toContain('scripts/prepare-local-runtime.mjs')
    expect(build).toContain("'smoke-runtime'")
    expect(build).toContain('verify sealed Runtime + Harness Web readiness')
    expect(build).toContain("cargoCommand")
    expect(build).toContain("tauri-cli")
  })

  it('routes normal root desktop packaging through the safe local build chain', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['tauri:build']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['build:desktop']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['local:prepare-runtime']).toBe('node scripts/prepare-local-runtime.mjs')
  })

  it('keeps generated local Runtime/tool/cache state out of git', () => {
    const gitignore = read('.gitignore')
    expect(gitignore).toContain('.local-cache/')
    expect(gitignore).toContain('.local-tools/')
    expect(gitignore).toContain('.local-logs/')
    expect(gitignore).toContain('apps/tauri/src-tauri/resources/dsh-runtime/')
  })
})
