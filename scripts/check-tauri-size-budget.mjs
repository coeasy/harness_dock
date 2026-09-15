import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const MB = 1024 * 1024
const budgets = [
  { name: 'Windows NSIS', test: (file) => /setup\.exe$/i.test(file), max: 150 * MB },
  { name: 'Windows MSI', test: (file) => /\.msi$/i.test(file), max: 170 * MB },
  { name: 'macOS DMG', test: (file) => /\.dmg$/i.test(file), max: 180 * MB },
  { name: 'Linux DEB', test: (file) => /\.deb$/i.test(file), max: 160 * MB },
  { name: 'Linux AppImage', test: (file) => /\.AppImage$/i.test(file), max: 190 * MB },
]

const requireArtifact = process.argv.includes('--require')
const roots = process.argv.slice(2).filter((arg) => arg !== '--require')
if (roots.length === 0) roots.push('apps/tauri/src-tauri/target/release/bundle')

function filesUnder(root) {
  const result = []
  let stat
  try { stat = statSync(root) } catch { return result }
  if (stat.isFile()) return [root]
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(target))
    else if (entry.isFile()) result.push(target)
  }
  return result
}

const files = roots.flatMap(filesUnder)
let matched = 0
let failed = false
for (const file of files) {
  const budget = budgets.find((entry) => entry.test(file))
  if (!budget) continue
  matched += 1
  const bytes = statSync(file).size
  const mib = (bytes / MB).toFixed(2)
  const limit = (budget.max / MB).toFixed(0)
  console.log(`[size-budget] ${budget.name}: ${file} = ${mib} MiB (limit ${limit} MiB)`)
  if (bytes > budget.max) {
    console.error(`[size-budget] FAIL ${budget.name}: ${mib} MiB exceeds ${limit} MiB`)
    failed = true
  }
}

if (requireArtifact && matched === 0) {
  console.error('[size-budget] no desktop candidate artifact matched a configured budget')
  failed = true
}
if (failed) process.exit(1)
console.log(`[size-budget] ${matched} desktop artifact(s) within configured limits`)
