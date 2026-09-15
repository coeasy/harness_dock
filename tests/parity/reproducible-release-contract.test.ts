import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')

describe('reproducible release contract', () => {
  it('pins the Rust compiler and commits the Tauri dependency lock at the active product version', () => {
    const root = JSON.parse(read('package.json'))
    expect(read('rust-toolchain.toml')).toContain('channel = "1.98.0"')
    const lockPath = path.join(repoRoot, 'apps/tauri/src-tauri/Cargo.lock')
    expect(existsSync(lockPath)).toBe(true)
    const lock = read('apps/tauri/src-tauri/Cargo.lock')
    expect(lock).toContain('name = "harnessdock-tauri"')
    expect(lock).toMatch(
      new RegExp(`name = "harnessdock-tauri"\\r?\\nversion = "${root.version.replaceAll('.', '\\.')}"`),
    )
    expect(read('apps/tauri/package.json')).toContain('cargo check --locked')
  })

  it('requires locked Rust resolution in CI and candidate validation', () => {
    const ci = read('.github/workflows/ci.yml')
    const tauriCi = read('.github/workflows/tauri-ci.yml')
    const candidate = read('.github/workflows/tauri-candidate.yml')
    expect(ci).toContain('cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml')
    expect(ci).toContain('cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml -- --check')
    expect(ci).toContain('cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --lib')
    expect(tauriCi).toContain('cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml')
    expect(candidate).toContain('cargo metadata --locked --manifest-path apps/tauri/src-tauri/Cargo.toml')
    for (const workflow of [ci, tauriCi, candidate]) expect(workflow).toContain('toolchain: 1.98.0')
  })

  it('dry-runs the independent Harness Shell publication in CI and candidate validation', () => {
    const root = JSON.parse(read('package.json'))
    expect(root.scripts['check:shell-package']).toContain('check-shell-package.mjs')
    const checker = read('scripts/check-shell-package.mjs')
    expect(checker).toContain("['pack', '--dry-run', '--json', '--ignore-scripts']")
    expect(checker).toContain("'manifest.json', 'lib/index.js', 'web/shell.js'")
    expect(read('.github/workflows/ci.yml')).toContain('Verify publishable Harness Shell package')
    expect(read('.github/workflows/tauri-candidate.yml')).toContain('Verify publishable Harness Shell package')
  })
})
