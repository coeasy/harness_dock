#!/usr/bin/env node
/**
 * Check that every version-bearing product artifact matches the repo root
 * package.json version (single source of truth for the v0.2.0 release train).
 * Exit 0 and print "all versions match: <version>" on success, exit 1 and
 * print each mismatch otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const rootVersion = rootPkg.version
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

const mismatches = []
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

const cargoPath = path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'Cargo.toml')
if (existsSync(cargoPath)) {
  const cargo = readFileSync(cargoPath, 'utf8')
  const packageVersion = cargo.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (packageVersion !== rootVersion) {
    mismatches.push(`apps/tauri/src-tauri/Cargo.toml: ${packageVersion} (root: ${rootVersion})`)
  }
}

if (mismatches.length > 0) {
  console.error('version mismatch detected:')
  for (const mismatch of mismatches) console.error(`  ${mismatch}`)
  process.exit(1)
}

console.log(`all versions match: ${rootVersion}`)
