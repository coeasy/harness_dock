#!/usr/bin/env node
/**
 * Check that every active version-bearing product artifact matches the repo
 * root package.json version. Historical release notes are intentionally not
 * part of this gate; runtime/config/package/UI contracts are.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const rootVersion = rootPkg.version
const releaseManifest = JSON.parse(readFileSync(path.join(repoRoot, 'release-manifest.json'), 'utf8'))
const shellContract = JSON.parse(readFileSync(path.join(repoRoot, 'protocol', 'shell-contract.json'), 'utf8'))
const mismatches = []

let activeReleaseTag = `v${rootVersion}`
if (releaseManifest.channel === 'beta') {
  if (typeof releaseManifest.prerelease !== 'string' || !/^beta\.\d+$/.test(releaseManifest.prerelease)) {
    mismatches.push(`release-manifest.json prerelease: expected beta.<number>, got ${releaseManifest.prerelease}`)
  } else {
    activeReleaseTag = `v${rootVersion}-${releaseManifest.prerelease}`
  }
} else if (releaseManifest.prerelease) {
  mismatches.push(`release-manifest.json prerelease must be empty outside beta channel: ${releaseManifest.prerelease}`)
}

const versionedFiles = [
  ['apps/tauri/src-tauri/tauri.conf.json', (value) => value.version],
  ['release-manifest.json', (value) => value.version],
  ['packages/docs-sync/origin.json', (value) => value.clientVersion],
  ['packages/plugin-harness-shell/manifest.json', (value) => value.version],
]

const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
const globs = workspaceYaml
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.replace(/^-\s*/, ''))

for (const glob of globs) {
  if (!glob.endsWith('/*')) continue
  const scopeDir = path.join(repoRoot, glob.slice(0, -2))
  if (!existsSync(scopeDir)) continue
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgPath = path.join(scopeDir, entry.name, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.version && pkg.version !== rootVersion) {
      mismatches.push(`${path.relative(repoRoot, pkgPath)}: ${pkg.version} (root: ${rootVersion})`)
    }
  }
}

for (const [relativePath, readVersion] of versionedFiles) {
  const filePath = path.join(repoRoot, relativePath)
  if (!existsSync(filePath)) {
    mismatches.push(`${relativePath}: file is missing`)
    continue
  }
  const value = JSON.parse(readFileSync(filePath, 'utf8'))
  const version = readVersion(value)
  if (version !== rootVersion) {
    mismatches.push(`${relativePath}: ${version} (root: ${rootVersion})`)
  }
}

const rustToolchainPath = path.join(repoRoot, 'rust-toolchain.toml')
if (!existsSync(rustToolchainPath)) {
  mismatches.push('rust-toolchain.toml: file is missing; release Rust toolchain must be frozen')
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
if (existsSync(cargoPath)) {
  const cargo = readFileSync(cargoPath, 'utf8')
  const packageVersion = cargo.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (packageVersion !== rootVersion) {
    mismatches.push(`apps/tauri/src-tauri/Cargo.toml: ${packageVersion} (root: ${rootVersion})`)
  }
}

if (releaseManifest.shell?.version !== rootVersion) {
  mismatches.push(`release-manifest.json shell.version: ${releaseManifest.shell?.version} (root: ${rootVersion})`)
}
if (releaseManifest.shell?.apiVersion !== shellContract.apiVersion) {
  mismatches.push(
    `release-manifest.json shell.apiVersion: ${releaseManifest.shell?.apiVersion} (shell contract: ${shellContract.apiVersion})`,
  )
}

const originPath = path.join(repoRoot, 'packages', 'docs-sync', 'origin.json')
if (existsSync(originPath)) {
  const origin = JSON.parse(readFileSync(originPath, 'utf8'))
  const expectedTag = `/releases/download/${activeReleaseTag}/`
  for (const [target, bundle] of Object.entries(origin.runtimeBundles ?? {})) {
    if (typeof bundle?.url !== 'string' || !bundle.url.includes(expectedTag)) {
      mismatches.push(`packages/docs-sync/origin.json runtimeBundles.${target}.url: expected ${expectedTag}`)
    }
  }
}

// Generated shell identity is the active source-level version contract. The
// plugin entrypoint imports it instead of repeating a string literal, so do
// not force a duplicate `export const version = 'x.y.z'` back into source.
const shellGeneratedPath = path.join(
  repoRoot,
  'packages',
  'plugin-harness-shell',
  'src',
  'shell-contract.generated.ts',
)
if (!existsSync(shellGeneratedPath)) {
  mismatches.push('packages/plugin-harness-shell/src/shell-contract.generated.ts: file is missing')
} else {
  const generated = readFileSync(shellGeneratedPath, 'utf8')
  const generatedVersion = generated.match(/SHELL_VERSION\s*=\s*"([^"]+)"/)?.[1]
  const generatedApi = Number(generated.match(/SHELL_API_VERSION\s*=\s*(\d+)/)?.[1])
  if (generatedVersion !== rootVersion) {
    mismatches.push(`packages/plugin-harness-shell/src/shell-contract.generated.ts: ${generatedVersion} (root: ${rootVersion})`)
  }
  if (generatedApi !== shellContract.apiVersion) {
    mismatches.push(`packages/plugin-harness-shell/src/shell-contract.generated.ts apiVersion: ${generatedApi} (shell contract: ${shellContract.apiVersion})`)
  }
}

// The checked-in compiled Node entry remains a direct package consumer, so its
// version must still match even though the TypeScript source now consumes the
// generated identity module.
const shellLibPath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'lib', 'index.js')
if (!existsSync(shellLibPath)) {
  mismatches.push('packages/plugin-harness-shell/lib/index.js: file is missing')
} else {
  const bundledVersion = readFileSync(shellLibPath, 'utf8').match(/var version = "([^"]+)"/)?.[1]
  if (bundledVersion !== rootVersion) {
    mismatches.push(`packages/plugin-harness-shell/lib/index.js: ${bundledVersion} (root: ${rootVersion})`)
  }
}

// The web source is now a template so the canonical Shell API/plugin identity
// can be injected at build time. Compare the checked-in publishable asset with
// the rendered template rather than with unresolved source placeholders.
const shellWebSourcePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'src', 'web', 'shell.js')
const shellWebBundlePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'web', 'shell.js')
if (existsSync(shellWebSourcePath) && existsSync(shellWebBundlePath)) {
  const source = readFileSync(shellWebSourcePath, 'utf8')
  const pluginLiteral = `'${String(shellContract.pluginId).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  const expectedBundle = source
    .replaceAll('__SHELL_API_VERSION__', String(shellContract.apiVersion))
    .replaceAll('__SHELL_PLUGIN_ID__', pluginLiteral)
  const bundle = readFileSync(shellWebBundlePath, 'utf8')
  if (expectedBundle !== bundle) {
    mismatches.push('packages/plugin-harness-shell/web/shell.js: stale generated web bundle; run the shell bundle step')
  }
}

const shellEntrySourcePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'src', 'index.ts')
if (existsSync(shellEntrySourcePath) && existsSync(shellLibPath)) {
  const source = readFileSync(shellEntrySourcePath, 'utf8')
  const bundle = readFileSync(shellLibPath, 'utf8')
  if (source.includes("register?.('harnessShell', service)") && !bundle.includes('register?.("harnessShell", service)')) {
    mismatches.push('packages/plugin-harness-shell/lib/index.js: missing current harnessShell registration contract')
  }
  if (source.includes('registration error must fail open') && !bundle.includes('try {')) {
    mismatches.push('packages/plugin-harness-shell/lib/index.js: missing fail-open registration guard')
  }
}

const activeDisplayFiles = [
  ['README.md', `HarnessDock v${rootVersion}`],
  ['apps/tauri/README.md', `HarnessDock Tauri v${rootVersion}`],
  ['apps/tauri/web/index.html', `HarnessDock v${rootVersion}`],
  ['apps/tauri/web/settings.html', `HarnessDock v${rootVersion}`],
]
for (const [relativePath, expected] of activeDisplayFiles) {
  const filePath = path.join(repoRoot, relativePath)
  if (!existsSync(filePath)) {
    mismatches.push(`${relativePath}: file is missing`)
    continue
  }
  if (!readFileSync(filePath, 'utf8').includes(expected)) {
    mismatches.push(`${relativePath}: missing active version marker ${expected}`)
  }
}

const rootReadme = path.join(repoRoot, 'README.md')
if (existsSync(rootReadme)) {
  const readme = readFileSync(rootReadme, 'utf8')
  if (!readme.includes(`| 当前发布 tag | \`${activeReleaseTag}\` |`)) {
    mismatches.push(`README.md: missing active release tag ${activeReleaseTag}`)
  }
}

if (mismatches.length > 0) {
  console.error('version mismatch detected:')
  for (const mismatch of mismatches) console.error(`  ${mismatch}`)
  process.exit(1)
}

console.log(`all active versions match: ${rootVersion} (${activeReleaseTag})`)
