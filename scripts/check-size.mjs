#!/usr/bin/env node
/**
 * Size-budget gate for the desktop release artifacts (scheme D4).
 *
 * Scans apps/desktop/release (recursively: release/thin, release/full,
 * release/full-pruned, ...) for HarnessDock-*.exe / HarnessDock-*.zip,
 * groups them by scenario (-thin / -full) and kind (Portable / Setup / zip),
 * and compares each against the release budget:
 *
 *   thin  Portable / Setup <= 90 MB,  zip <= 125 MB
 *   full  Portable / Setup <= 165 MB, zip <= 230 MB
 *
 * When several files map to the same (scenario, kind) bucket — e.g. the same
 * artifact name produced in both release/full and release/full-pruned — only
 * the smallest is counted, so a pruned full build wins over the unpruned one.
 *
 * Exit codes (best-effort by design):
 *   0  all budgets pass, or no artifacts were found (pure source build)
 *   1  at least one artifact exceeds its budget
 *
 * Usage:
 *   node scripts/check-size.mjs
 *   DSH_RELEASE_ROOT=<dir> node scripts/check-size.mjs   # override scan dir (CI / staging)
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = process.env.DSH_RELEASE_ROOT ?? path.join(repoRoot, 'apps', 'desktop', 'release')

// scenario -> kind -> budget (MB)
const BUDGETS = {
  thin: { Portable: 90, Setup: 90, zip: 125 },
  full: { Portable: 165, Setup: 165, zip: 230 },
}

const ARTIFACT_RE = /^HarnessDock-.*\.(exe|zip)$/i
const SCENARIO_RE = /-(thin|full)\.(exe|zip)$/i
const MB = 1024 * 1024

function kindOf(name) {
  if (/Portable/i.test(name)) return 'Portable'
  if (/Setup/i.test(name)) return 'Setup'
  if (/\.zip$/i.test(name)) return 'zip'
  return null
}

async function findArtifacts() {
  const found = []
  let entries
  try {
    entries = await readdir(releaseRoot, { recursive: true, withFileTypes: true })
  } catch {
    return found // release dir does not exist yet
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

// Keep the smallest file per (scenario, kind) bucket so a pruned full build
// (release/full-pruned) is counted instead of the identically-named unpruned
// artifact in release/full when both exist.
function dedupe(artifacts) {
  const best = new Map()
  for (const a of artifacts) {
    const key = `${a.scenario}:${a.kind}`
    const prev = best.get(key)
    if (!prev || a.bytes < prev.bytes) best.set(key, a)
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
for (const a of artifacts) {
  const budget = BUDGETS[a.scenario]?.[a.kind]
  const sizeMb = a.bytes / MB
  const label = `${a.scenario}/${a.kind}`
  if (budget == null) {
    console.log(`  ${label.padEnd(16)} ${a.name}  ${sizeMb.toFixed(1)} MB  (no budget rule — skipped)`)
    continue
  }
  const over = sizeMb > budget
  if (over) failed = true
  console.log(
    `  ${label.padEnd(16)} ${a.name}  ${sizeMb.toFixed(1)} MB  (<= ${budget.toFixed(1)} MB) ${over ? 'OVER BUDGET' : 'ok'}`,
  )
}

if (failed) {
  console.error('\n[check:size] FAILED: one or more artifacts exceed their size budget.')
  process.exit(1)
}
console.log('\n[check:size] all size budgets pass.')
process.exit(0)
