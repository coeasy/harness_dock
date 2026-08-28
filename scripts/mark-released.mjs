#!/usr/bin/env node
/**
 * Mark the current origin + client version as "the last released" baseline.
 *
 * Run right before/after cutting a release (after `pnpm sync:dsh` and bumping
 * the client version). `scripts/check-release.mjs` uses this baseline to refuse
 * a later origin change that did not bump the client version.
 *
 * Usage: node scripts/mark-released.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), 'utf8'),
)
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

const marker = {
  dshVersion: origin.dshVersion,
  clientVersion: rootPkg.version,
  markedAt: new Date().toISOString(),
}

const destDir = path.join(repoRoot, 'packages', 'docs-sync')
mkdirSync(destDir, { recursive: true })
writeFileSync(path.join(destDir, 'released-origin.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
console.log(`mark:released OK: dsh=${marker.dshVersion} client=${marker.clientVersion}`)
