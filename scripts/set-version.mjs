#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const version = args.find((arg) => !arg.startsWith('--'))

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <x.y.z[-prerelease]> [--dry-run]')
  process.exit(1)
}

const changed = []
const packageFiles = collectPackageJsonFiles()
for (const file of packageFiles) {
  const json = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof json.version !== 'string' || json.version === version) continue
  json.version = version
  writeJson(file, json)
}

const originPath = path.join(repoRoot, 'packages/docs-sync/origin.json')
if (existsSync(originPath)) {
  const origin = JSON.parse(readFileSync(originPath, 'utf8'))
  if (origin.clientVersion !== version) {
    origin.clientVersion = version
    writeJson(originPath, origin)
  }
}

for (const file of [
  path.join(repoRoot, 'apps/perry/perry.toml'),
  path.join(repoRoot, 'apps/mobile/perry.toml'),
]) {
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8')
  const next = raw.replace(/^(version\s*=\s*)["'][^"']+["']/m, `$1"${version}"`)
  if (next !== raw) writeText(file, next)
}

if (changed.length === 0) {
  console.log(`version already synchronized: ${version}`)
} else {
  console.log(`${dryRun ? 'would update' : 'updated'} version to ${version}:`)
  for (const file of changed) console.log(`- ${path.relative(repoRoot, file)}`)
}

function collectPackageJsonFiles() {
  const files = [path.join(repoRoot, 'package.json')]
  const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const roots = workspaceYaml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((pattern) => pattern.endsWith('/*'))
    .map((pattern) => path.join(repoRoot, pattern.slice(0, -2)))

  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(root, entry.name, 'package.json')
      if (existsSync(file)) files.push(file)
    }
  }
  return [...new Set(files)]
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(file, content) {
  changed.push(file)
  if (!dryRun) writeFileSync(file, content, 'utf8')
}
