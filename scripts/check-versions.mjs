#!/usr/bin/env node
/**
 * Check that every workspace package.json version matches the repo root
 * package.json version (single source of truth).
 * Exit 0 and print "all versions match: <version>" on success, exit 1 and
 * print each mismatch otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const rootVersion = rootPkg.version

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

if (mismatches.length > 0) {
  console.error('version mismatch detected:')
  for (const mismatch of mismatches) console.error(`  ${mismatch}`)
  process.exit(1)
}

console.log(`all versions match: ${rootVersion}`)
