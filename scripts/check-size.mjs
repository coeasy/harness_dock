#!/usr/bin/env node
/**
 * Size-budget gate for desktop release artifacts (scheme D4).
 *
 * Scans apps/desktop/release recursively for HarnessDock desktop packages,
 * groups them by scenario (-thin / -full) and package kind, and compares each
 * against the release budget.
 *
 * Package kinds covered:
 *   Windows: Portable.exe, Setup.exe, zip
 *   macOS:   dmg, zip
 *   Linux:   AppImage, deb
 *
 * Compressed installer/archive budgets intentionally share the same envelope:
 *   thin <= 125 MB
 *   full <= 230 MB
 * Windows self-extracting executables retain their tighter historical budgets:
 *   thin Portable / Setup <= 90 MB
 *   full Portable / Setup <= 165 MB
 *
 * When several files map to the same (scenario, kind) bucket, only the
 * smallest is counted so a pruned build can win over an unpruned duplicate.
 *
 * Exit codes (best-effort by design):
 *   0  all discovered budgets pass, or no artifacts were found (pure source build)
 *   1  at least one artifact exceeds its budget
 *
 * Usage:
 *   node scripts/check-size.mjs
 *   DSH_RELEASE_ROOT=<dir> node scripts/check-size.mjs
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = process.env.DSH_RELEASE_ROOT ?? path.join(repoRoot, 'apps', 'desktop', 'release')

const BUDGETS = {
  thin: { Portable: 90, Setup: 90, zip: 125, dmg: 125, AppImage: 125, deb: 125 },
  full: { Portable: 165, Setup: 165, zip: 230, dmg: 230, AppImage: 230, deb: 230 },
}

const ARTIFACT_RE = /^HarnessDock-.*\.(exe|zip|dmg|AppImage|deb)$/i
const SCENARIO_RE = /-(thin|full)\.(exe|zip|dmg|AppImage|deb)$/i
const MB = 1024 * 1024

function kindOf(name) {
  if (/Portable/i.test(name)) return 'Portable'
  if (/Setup/i.test(name)) return 'Setup'
  if (/\.AppImage$/i.test(name)) return 'AppImage'
  if (/\.deb$/i.test(name)) return 'deb'
  if (/\.dmg$/i.test(name)) return 'dmg'
  if (/\.zip$/i.test(name)) return 'zip'
  return null
}

async function findArtifacts() {
  const found = []
  let entries
  try {
    entries = await readdir(releaseRoot, { recursive: true, withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    if (!ARTIFACT_RE.test(entry.name)) continue
    const scenarioMatch = SCENARIO_RE.exec(entry.name)
    if (!scenarioMatch) continue
    const kind = kindOf(entry.name)
    if (!kind) continue
    const info = await stat(full)
    found.push({ name: entry.name, scenario: scenarioMatch[1], kind, bytes: info.size })
  }
  return found
}

function dedupe(artifacts) {
  const best = new Map()
  for (const artifact of artifacts) {
    const key = `${artifact.scenario}:${artifact.kind}`
    const previous = best.get(key)
    if (!previous || artifact.bytes < previous.bytes) best.set(key, artifact)
  }
  return [...best.values()]
}

const artifacts = dedupe(await findArtifacts())

if (artifacts.length === 0) {
  console.log(
    `[check:size] no release artifacts under ${path.relative(repoRoot, releaseRoot)} ` +
      `(pure source build is fine).\n` +
      `Generate them first, e.g. pnpm pack:desktop:win / pnpm pack:desktop:win:full, then re-run.`,
  )
  process.exit(0)
}

artifacts.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.kind.localeCompare(b.kind))

let failed = false
console.log('[check:size] release artifact sizes (budget gate):')
for (const artifact of artifacts) {
  const budget = BUDGETS[artifact.scenario]?.[artifact.kind]
  const sizeMb = artifact.bytes / MB
  const label = `${artifact.scenario}/${artifact.kind}`
  if (budget == null) {
    console.log(`  ${label.padEnd(16)} ${artifact.name}  ${sizeMb.toFixed(1)} MB  (no budget rule - skipped)`)
    continue
  }
  const over = sizeMb > budget
  if (over) failed = true
  console.log(
    `  ${label.padEnd(16)} ${artifact.name}  ${sizeMb.toFixed(1)} MB  (<= ${budget.toFixed(1)} MB) ${over ? 'OVER BUDGET' : 'ok'}`,
  )
}

if (failed) {
  console.error('\n[check:size] FAILED: one or more artifacts exceed their size budget.')
  process.exit(1)
}
console.log('\n[check:size] all size budgets pass.')
process.exit(0)
