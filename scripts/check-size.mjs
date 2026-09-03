#!/usr/bin/env node
/**
 * Size-budget gate for Tauri release artifacts.
 *
 * Desktop installers intentionally remain self-contained: Node + pinned dsh
 * are embedded in every desktop package. These budgets therefore measure a
 * compact Full Runtime product, not a Host-only/bootstrap downloader.
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = process.env.DSH_RELEASE_ROOT ?? path.join(repoRoot, 'apps', 'tauri', 'src-tauri', 'target')
const MB = 1024 * 1024
const BUDGETS_MB = {
  exe: 150,
  msi: 170,
  dmg: 180,
  AppImage: 190,
  deb: 160,
  apk: 180,
  aab: 180,
  zip: 190,
}
const ARTIFACT_RE = /^HarnessDock[-_].*\.(exe|msi|dmg|AppImage|deb|apk|aab|zip)$/i

function kindOf(name) {
  const extension = name.slice(name.lastIndexOf('.') + 1)
  return extension.toLowerCase() === 'appimage' ? 'AppImage' : extension
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
    if (!entry.isFile() || !ARTIFACT_RE.test(entry.name)) continue
    const full = path.join(entry.parentPath, entry.name)
    found.push({ name: entry.name, kind: kindOf(entry.name), bytes: (await stat(full)).size })
  }
  return found
}

const artifacts = await findArtifacts()
if (artifacts.length === 0) {
  console.log(
    `[check:size] no Tauri release artifacts under ${path.relative(repoRoot, releaseRoot)} ` +
      '(source-only builds are fine).',
  )
  process.exit(0)
}

let failed = false
for (const artifact of artifacts.sort((a, b) => a.name.localeCompare(b.name))) {
  const budget = BUDGETS_MB[artifact.kind]
  const sizeMb = artifact.bytes / MB
  if (budget == null) continue
  const over = sizeMb > budget
  failed ||= over
  console.log(
    `  ${artifact.kind.padEnd(8)} ${artifact.name} ${sizeMb.toFixed(1)} MB ` +
      `(<= ${budget} MB)${over ? ' OVER BUDGET' : ''}`,
  )
}
if (failed) {
  console.error('\n[check:size] FAILED: one or more Tauri artifacts exceed the compact Full Runtime budget.')
  process.exit(1)
}
console.log('\n[check:size] all compact Full Runtime artifact budgets pass.')
