import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')
const readJson = (relative: string) => JSON.parse(read(relative))
const runNodeGate = (relative: string, args: string[] = []) =>
  spawnSync(process.execPath, [path.join(repoRoot, relative), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

describe('reproducible release contract', () => {
  it('pins the Rust compiler and commits the Tauri dependency lock at the active product version', () => {
    const root = readJson('package.json')
    const cargoToml = read('apps/tauri/src-tauri/Cargo.toml')
    const cargoLockPath = path.join(repoRoot, 'apps/tauri/src-tauri/Cargo.lock')
    const cargoLock = read('apps/tauri/src-tauri/Cargo.lock')

    expect(read('rust-toolchain.toml')).toMatch(/channel\s*=\s*"1\.98\.0"/)
    expect(existsSync(cargoLockPath)).toBe(true)
    expect(cargoToml).toMatch(new RegExp(`^version\\s*=\\s*"${root.version.replaceAll('.', '\\.')}"$`, 'm'))
    expect(cargoLock).toMatch(
      new RegExp(`name = "harnessdock-tauri"\\r?\\nversion = "${root.version.replaceAll('.', '\\.')}"`),
    )
  })

  it('keeps the release manifest tied to immutable origin and canonical shell identities', () => {
    const root = readJson('package.json')
    const origin = readJson('packages/docs-sync/origin.json')
    const release = readJson('release-manifest.json')
    const shell = readJson('packages/plugin-harness-shell/manifest.json')
    const shellContract = readJson('protocol/shell-contract.json')

    expect(origin.clientVersion).toBe(root.version)
    expect(release.version).toBe(root.version)
    expect(release.runtime.version).toBe(origin.dshVersion)
    expect(release.runtime.gitTag).toBe(origin.gitTag)
    expect(release.runtime.gitCommit).toBe(origin.gitCommit)
    expect(release.shell.version).toBe(shell.version)
    expect(release.shell.apiVersion).toBe(shellContract.apiVersion)
    expect(shell.apiVersion).toBe(shellContract.apiVersion)
  })

  it('executes the canonical release and generated-contract checks instead of duplicating workflow source text', () => {
    for (const [relative, args] of [
      ['scripts/check-release.mjs', []],
      ['scripts/check-tauri-source-layout.mjs', []],
      ['scripts/generate-host-protocol.mjs', ['--check']],
      ['scripts/generate-shell-contract.mjs', ['--check']],
      ['scripts/generate-runtime-ready-contract.mjs', ['--check']],
    ] as const) {
      const result = runNodeGate(relative, [...args])
      expect(result.status, `${relative}\n${result.stdout}\n${result.stderr}`).toBe(0)
    }
  })

  it('keeps the independent Harness Shell publication contract explicit', () => {
    const root = readJson('package.json')
    const shellPackage = readJson('packages/plugin-harness-shell/package.json')
    const shellManifest = readJson('packages/plugin-harness-shell/manifest.json')

    expect(root.scripts['check:shell-package']).toContain('check-shell-package.mjs')
    expect(shellPackage.name).toBe('@dsh/plugin-harness-shell')
    expect(shellPackage.version).toBe(root.version)
    expect(shellManifest.entry).toBe('lib/index.js')
    expect(shellManifest.webEntry).toBe('web/shell.js')
    expect(shellManifest.safeMode).toBe(true)
  })

  it('keeps security auditing and locked dependency resolution as repository gates', () => {
    expect(existsSync(path.join(repoRoot, '.github/workflows/security-audit.yml'))).toBe(true)
    const packageJson = readJson('package.json')
    expect(packageJson.packageManager).toBe('pnpm@10.12.1')
    expect(existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))).toBe(true)
  })
})
