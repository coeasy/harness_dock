#!/usr/bin/env node
/**
 * Release discipline gate for the Tauri updater.
 *
 * Tauri treats the application version as the single forward unit: a release
 * ships a new client version together with a new pinned origin.json. If a
 * docs-sync PR bumps origin.json without bumping the client version, the
 * updater can consider the same client version already current and users may
 * never receive the new pinned dsh. This script refuses such a release.
 *
 * Rules:
 *  1. origin.json.dshVersion must be an exact version (never latest/next).
 *  2. origin.json.clientVersion must equal the root package.json version.
 *  3. If origin.json.dshVersion changed since released-origin.json (the last
 *     marked release) then the client version must have been bumped too.
 *
 * Usage: node scripts/check-release.mjs   (exit 0 = safe to release)
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const origin = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), 'utf8'),
)
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'release-manifest.json'), 'utf8'))
const releasedPath = path.join(repoRoot, 'packages', 'docs-sync', 'released-origin.json')

const errors = []
const clientVersion = rootPkg.version
const { dshVersion } = origin

if (manifest.version !== clientVersion) {
  errors.push(
    `release-manifest.json.version (${manifest.version}) != package.json version (${clientVersion})`,
  )
}
if (manifest.shell?.version !== clientVersion) {
  errors.push(
    `release-manifest.json.shell.version (${manifest.shell?.version}) != package.json version (${clientVersion})`,
  )
}
if (manifest.shell?.apiVersion !== 1) {
  errors.push('release-manifest.json.shell.apiVersion must be 1')
}
if (manifest.runtime?.version !== origin.dshVersion) {
  errors.push(
    `release-manifest.json.runtime.version (${manifest.runtime?.version}) != origin.json.dshVersion (${origin.dshVersion})`,
  )
}
if (manifest.runtime?.gitCommit !== origin.gitCommit) {
  errors.push('release-manifest.json.runtime.gitCommit != origin.json.gitCommit')
}

if (!dshVersion || typeof dshVersion !== 'string') {
  errors.push('origin.json is missing dshVersion')
} else if (['latest', 'next'].includes(dshVersion.trim().toLowerCase())) {
  errors.push(`origin.json pins floating dist-tag "${dshVersion}"; use an exact version`)
}

if (origin.clientVersion !== clientVersion) {
  errors.push(
    `origin.json.clientVersion (${origin.clientVersion}) != package.json version (${clientVersion}); run \`pnpm sync:dsh\` to regenerate`,
  )
}

if (existsSync(releasedPath)) {
  const released = JSON.parse(readFileSync(releasedPath, 'utf8'))
  if (released.dshVersion !== dshVersion && released.clientVersion === clientVersion) {
    errors.push(
      `origin changed (${released.dshVersion} -> ${dshVersion}) but client version was NOT bumped (still ${clientVersion}); ` +
        `Tauri would not deliver this update. Bump the client version, then \`pnpm mark:released\`.`,
    )
  }
}

if (errors.length > 0) {
  console.error('check:release FAILED:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(
  `check:release OK: dsh=${dshVersion} client=${clientVersion}${existsSync(releasedPath) ? '' : ' (no released-origin baseline yet)'}`,
)
