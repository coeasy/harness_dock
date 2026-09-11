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
const mismatches = []

const toolVersionsPath = path.join(repoRoot, 'scripts', 'versions.json')
const toolVersions = existsSync(toolVersionsPath) ? JSON.parse(readFileSync(toolVersionsPath, 'utf8')) : {}
const rustVersion = String(toolVersions.rust ?? '')
const tauriCliVersion = String(toolVersions.tauriCli ?? '')
for (const [name, version] of [
  ['rust', rustVersion],
  ['tauriCli', tauriCliVersion],
]) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    mismatches.push(`scripts/versions.json ${name}: expected exact SemVer, got ${version || '<missing>'}`)
  }
}

let activeReleaseTag = `v${rootVersion}`
if (releaseManifest.channel !== 'stable') {
  const channel = String(releaseManifest.channel || '')
  const expectedPrerelease = new RegExp(`^${channel}\\.\\d+$`)
  if (typeof releaseManifest.prerelease !== 'string' || !expectedPrerelease.test(releaseManifest.prerelease)) {
    mismatches.push(`release-manifest.json prerelease: expected ${channel}.<number>, got ${releaseManifest.prerelease}`)
  } else {
    activeReleaseTag = `v${rootVersion}-${releaseManifest.prerelease}`
  }
} else if (releaseManifest.prerelease) {
  mismatches.push(`release-manifest.json prerelease must be empty for stable channel: ${releaseManifest.prerelease}`)
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
  if (rustVersion && !rustToolchain.includes(`channel = "${rustVersion}"`)) {
    mismatches.push(`rust-toolchain.toml: expected Rust ${rustVersion} from scripts/versions.json`)
  }
}

const tauriCliActionPath = path.join(repoRoot, '.github', 'actions', 'setup-tauri-cli', 'action.yml')
if (!existsSync(tauriCliActionPath)) {
  mismatches.push('.github/actions/setup-tauri-cli/action.yml: exact Tauri CLI setup action is missing')
} else {
  const action = readFileSync(tauriCliActionPath, 'utf8')
  const requiredFragments = [
    "require('./scripts/versions.json').tauriCli",
    'uses: actions/cache@v6',
    'cargo install tauri-cli',
    '--locked',
    '--root',
    'cache-hit',
  ]
  for (const fragment of requiredFragments) {
    if (!action.includes(fragment)) {
      mismatches.push(`.github/actions/setup-tauri-cli/action.yml: missing provenance guard ${fragment}`)
    }
  }
}

const tauriCliWorkflowFiles = ['.github/workflows/tauri-ci.yml', '.github/workflows/tauri-candidate.yml']
for (const relativePath of tauriCliWorkflowFiles) {
  const workflowPath = path.join(repoRoot, relativePath)
  if (!existsSync(workflowPath)) {
    mismatches.push(`${relativePath}: file is missing`)
    continue
  }
  const workflow = readFileSync(workflowPath, 'utf8')
  if (!workflow.includes('uses: ./.github/actions/setup-tauri-cli')) {
    mismatches.push(`${relativePath}: must use the exact cached Tauri CLI setup action`)
  }
  if (/cargo\s+install\s+tauri-cli\b/.test(workflow)) {
    mismatches.push(`${relativePath}: raw cargo install tauri-cli bypasses the shared tool provenance action`)
  }
  if (!workflow.includes("'scripts/versions.json'")) {
    mismatches.push(`${relativePath}: scripts/versions.json must trigger the workflow`)
  }
  if (!workflow.includes("'.github/actions/setup-tauri-cli/**'")) {
    mismatches.push(`${relativePath}: setup-tauri-cli action changes must trigger the workflow`)
  }
}

for (const relativePath of ['.github/workflows/ci.yml', ...tauriCliWorkflowFiles]) {
  const workflowPath = path.join(repoRoot, relativePath)
  if (!existsSync(workflowPath)) continue
  const workflow = readFileSync(workflowPath, 'utf8')
  const pins = [...workflow.matchAll(/^\s+(?:toolchain|rust-toolchain):\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/gm)].map((match) => match[1])
  for (const pin of pins) {
    if (rustVersion && pin !== rustVersion) {
      mismatches.push(`${relativePath}: Rust toolchain ${pin} differs from scripts/versions.json ${rustVersion}`)
    }
  }
}

const releaseWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml')
if (existsSync(releaseWorkflowPath)) {
  const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8')
  if (!releaseWorkflow.includes('node scripts/release/contract.mjs replaceable')) {
    mismatches.push('.github/workflows/release.yml: immutable prerelease maintenance gate is missing')
  }
  if (!releaseWorkflow.includes('Skipping publish for post-release maintenance SHA')) {
    mismatches.push('.github/workflows/release.yml: post-release maintenance skip must remain explicit')
  }
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

const releaseManifestPath = path.join(repoRoot, 'release-manifest.json')
if (existsSync(releaseManifestPath)) {
  const releaseManifestValue = JSON.parse(readFileSync(releaseManifestPath, 'utf8'))
  if (releaseManifestValue.shell?.version !== rootVersion) {
    mismatches.push(`release-manifest.json shell.version: ${releaseManifestValue.shell?.version} (root: ${rootVersion})`)
  }
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

const textVersionFiles = [
  ['packages/plugin-harness-shell/src/index.ts', /export const version = '([^']+)'/],
  ['packages/plugin-harness-shell/lib/index.js', /var version = "([^"]+)"/],
]
for (const [relativePath, pattern] of textVersionFiles) {
  const filePath = path.join(repoRoot, relativePath)
  if (!existsSync(filePath)) {
    mismatches.push(`${relativePath}: file is missing`)
    continue
  }
  const value = readFileSync(filePath, 'utf8').match(pattern)?.[1]
  if (value !== rootVersion) {
    mismatches.push(`${relativePath}: ${value} (root: ${rootVersion})`)
  }
}

// The shell package intentionally checks in its publishable web asset and
// compiled Node entry. Refuse source-only fixes that would leave a direct
// repository/npm consumer on stale behavior until a later candidate build.
const shellWebSourcePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'src', 'web', 'shell.js')
const shellWebBundlePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'web', 'shell.js')
if (existsSync(shellWebSourcePath) && existsSync(shellWebBundlePath)) {
  const source = readFileSync(shellWebSourcePath, 'utf8')
  const bundle = readFileSync(shellWebBundlePath, 'utf8')
  if (source !== bundle) {
    mismatches.push('packages/plugin-harness-shell/web/shell.js: stale generated web bundle; run the shell bundle step')
  }
}

const shellEntrySourcePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'src', 'index.ts')
const shellEntryBundlePath = path.join(repoRoot, 'packages', 'plugin-harness-shell', 'lib', 'index.js')
if (existsSync(shellEntrySourcePath) && existsSync(shellEntryBundlePath)) {
  const source = readFileSync(shellEntrySourcePath, 'utf8')
  const bundle = readFileSync(shellEntryBundlePath, 'utf8')
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
