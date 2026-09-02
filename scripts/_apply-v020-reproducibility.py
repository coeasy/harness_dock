from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


# Developer-facing pinned Rust toolchain.
Path("rust-toolchain.toml").write_text(
    '[toolchain]\nchannel = "1.98.0"\nprofile = "minimal"\ncomponents = ["rustfmt"]\n'
)

# Real package-shape validation for the independently publishable Shell plugin.
Path("scripts/check-shell-package.mjs").write_text(r'''#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages', 'plugin-harness-shell')
const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}))?.[0]
if (!packed) throw new Error('npm pack --dry-run did not return a package description')
if (packed.name !== '@dsh/plugin-harness-shell') throw new Error(`unexpected package name: ${packed.name}`)
if (packed.version !== packageJson.version) throw new Error(`package version drift: ${packed.version} != ${packageJson.version}`)
const files = new Set((packed.files ?? []).map((file) => file.path))
for (const required of ['package.json', 'manifest.json', 'lib/index.js', 'web/shell.js']) {
  if (!files.has(required)) throw new Error(`publishable Harness Shell is missing ${required}`)
}
for (const file of files) {
  if (file.startsWith('node_modules/') || file.includes('/node_modules/')) throw new Error(`node_modules leaked into shell package: ${file}`)
  if (file.includes('src-tauri/') || /\.(exe|dmg|appimage|deb|aab|apk)$/i.test(file)) throw new Error(`host binary leaked into shell package: ${file}`)
}
if (!Number.isFinite(packed.size) || packed.size <= 0 || packed.size > 512 * 1024) {
  throw new Error(`unexpected Harness Shell packed size: ${packed.size}`)
}
console.log(`[shell-package] ${packed.name}@${packed.version}: ${packed.size} bytes, ${files.size} files; publish contract passes.`)
''')

Path("tests/parity/reproducible-release-contract.test.ts").write_text(r'''import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')

describe('v0.2.0 reproducible release contract', () => {
  it('pins the Rust compiler and commits the Tauri dependency lock', () => {
    expect(read('rust-toolchain.toml')).toContain('channel = "1.98.0"')
    const lockPath = path.join(repoRoot, 'apps/tauri/src-tauri/Cargo.lock')
    expect(existsSync(lockPath)).toBe(true)
    const lock = read('apps/tauri/src-tauri/Cargo.lock')
    expect(lock).toContain('name = "harnessdock-tauri"')
    expect(lock).toContain('version = "0.2.0"')
    expect(read('apps/tauri/package.json')).toContain('cargo check --locked')
  })

  it('requires locked Rust resolution in CI and candidate validation', () => {
    const ci = read('.github/workflows/ci.yml')
    const tauriCi = read('.github/workflows/tauri-ci.yml')
    const candidate = read('.github/workflows/tauri-candidate.yml')
    expect(ci).toContain('cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml')
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
''')

# Root and local developer commands.
p = Path("package.json")
data = json.loads(p.read_text())
data["scripts"]["check:shell-package"] = "pnpm --filter @dsh/plugin-harness-shell build && node scripts/check-shell-package.mjs"
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

p = Path("apps/tauri/package.json")
data = json.loads(p.read_text())
data["scripts"]["tauri:check"] = "cargo check --locked --manifest-path src-tauri/Cargo.toml"
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

# Version gate owns the toolchain and lockfile too.
p = Path("scripts/check-versions.mjs")
text = p.read_text()
anchor = "const cargoPath = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'Cargo.toml')\nif (existsSync(cargoPath)) {"
insert = '''const rustToolchainPath = path.join(repoRoot, 'rust-toolchain.toml')
if (!existsSync(rustToolchainPath)) {
  mismatches.push('rust-toolchain.toml: file is missing; v0.2.0 Rust toolchain must be frozen')
} else {
  const rustToolchain = readFileSync(rustToolchainPath, 'utf8')
  if (!rustToolchain.includes('channel = "1.98.0"')) mismatches.push('rust-toolchain.toml: expected Rust 1.98.0')
}

const cargoLockPath = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'Cargo.lock')
if (!existsSync(cargoLockPath)) {
  mismatches.push('apps/tauri/src-tauri/Cargo.lock: file is missing; Tauri dependency resolution must be frozen')
} else {
  const cargoLock = readFileSync(cargoLockPath, 'utf8')
  const appPackage = cargoLock.match(/\[\[package\]\]\s+name = "harnessdock-tauri"\s+version = "([^"]+)"/m)?.[1]
  if (appPackage !== rootVersion) mismatches.push(`apps/tauri/src-tauri/Cargo.lock harnessdock-tauri: ${appPackage} (root: ${rootVersion})`)
}

const cargoPath = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'Cargo.toml')
if (existsSync(cargoPath)) {'''
text = replace_once(text, anchor, insert, "check-versions Cargo anchor")
p.write_text(text)

# Main CI.
p = Path(".github/workflows/ci.yml")
text = p.read_text()
text = replace_once(
    text,
    "      - uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n      - uses: Swatinem/rust-cache@v2",
    "CI Rust toolchain",
)
text = text.replace(
    "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml",
    "cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml",
)
text = text.replace(
    "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib",
    "cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --lib",
)
anchor = "      - run: pnpm --filter @dsh/plugin-harness-shell build\n      - name: Bundle and validate Gateway sidecar"
text = replace_once(
    text,
    anchor,
    "      - run: pnpm --filter @dsh/plugin-harness-shell build\n      - name: Verify publishable Harness Shell package\n        run: node scripts/check-shell-package.mjs\n      - name: Bundle and validate Gateway sidecar",
    "CI Shell package anchor",
)
p.write_text(text)

# Tauri PR smoke.
p = Path(".github/workflows/tauri-ci.yml")
text = p.read_text().replace("      - 'tests/parity/tauri-host.test.ts'", "      - 'tests/parity/**'")
text = text.replace(
    "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml",
    "cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml",
)
text = replace_once(
    text,
    "      - uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n      - uses: Swatinem/rust-cache@v2",
    "tauri-ci desktop Rust toolchain",
)
text = text.replace(
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          targets: aarch64-linux-android",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n          targets: aarch64-linux-android",
)
text = text.replace(
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          targets: aarch64-apple-ios-sim",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n          targets: aarch64-apple-ios-sim",
)
p.write_text(text)

# Candidate: lock preflight + real Shell package check in both validate and desktop candidate jobs.
p = Path(".github/workflows/tauri-candidate.yml")
text = p.read_text()
text = replace_once(
    text,
    "      - 'scripts/check-android-package.mjs'",
    "      - 'scripts/check-android-package.mjs'\n      - 'scripts/check-shell-package.mjs'\n      - 'rust-toolchain.toml'\n      - 'apps/tauri/src-tauri/Cargo.lock'",
    "candidate path filters",
)
setup_node = "      - uses: actions/setup-node@v7\n        with:\n          node-version: 24\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile --prefer-offline"
text = replace_once(
    text,
    setup_node,
    "      - uses: actions/setup-node@v7\n        with:\n          node-version: 24\n          cache: pnpm\n      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n      - run: pnpm install --frozen-lockfile --prefer-offline",
    "candidate validate toolchain",
)
text = replace_once(
    text,
    "      - run: pnpm check:release\n      - run: pnpm test",
    "      - run: pnpm check:release\n      - name: Verify frozen Tauri dependency graph\n        run: cargo metadata --locked --manifest-path apps/tauri/src-tauri/Cargo.toml --format-version 1 > /dev/null\n      - run: pnpm test",
    "candidate lock preflight",
)
shell_anchor = "      - name: Build independent Harness Shell plugin\n        run: pnpm --filter @dsh/plugin-harness-shell build\n      - name: Bundle Gateway sidecar"
shell_count = text.count(shell_anchor)
if shell_count != 2:
    raise SystemExit(f"candidate Shell package anchors: expected 2, found {shell_count}")
text = text.replace(
    shell_anchor,
    "      - name: Build independent Harness Shell plugin\n        run: pnpm --filter @dsh/plugin-harness-shell build\n      - name: Verify publishable Harness Shell package\n        run: node scripts/check-shell-package.mjs\n      - name: Bundle Gateway sidecar",
)
# Pin all remaining candidate Rust actions while preserving target blocks.
text = text.replace(
    "      - uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n      - uses: Swatinem/rust-cache@v2",
)
text = text.replace(
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          targets:",
    "      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: 1.98.0\n          targets:",
)
p.write_text(text)

print("v0.2.0 reproducibility migration applied")
