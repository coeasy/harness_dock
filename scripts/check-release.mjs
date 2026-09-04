#!/usr/bin/env node
/**
 * Release discipline gate for HarnessDock + the pinned DeepSeek Harness Runtime.
 *
 * Product-version policy:
 *   HarnessDock tracks the base SemVer of the pinned dsh release. Prerelease
 *   qualifiers belong to Runtime provenance, not to the HarnessDock product
 *   version. Example: dsh 0.1.2-rc.1 => HarnessDock 0.1.2.
 *
 * Rules:
 *  1. origin.json.dshVersion must be an exact SemVer (never latest/next).
 *  2. HarnessDock client version must equal the dsh base SemVer.
 *  3. origin.json.clientVersion must equal package.json version.
 *  4. release-manifest Runtime version/tag/commit must equal origin.json.
 *  5. If the pinned dsh changed since released-origin.json, the client version
 *     must also have changed so the updater/release identity cannot stay stale.
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
const exactDshMatch =
  typeof dshVersion === 'string'
    ? dshVersion.trim().match(/^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/)
    : null
const dshBaseVersion = exactDshMatch?.[1]

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
if (manifest.runtime?.gitTag !== origin.gitTag) {
  errors.push(
    `release-manifest.json.runtime.gitTag (${manifest.runtime?.gitTag}) != origin.json.gitTag (${origin.gitTag})`,
  )
}
if (manifest.runtime?.gitCommit !== origin.gitCommit) {
  errors.push('release-manifest.json.runtime.gitCommit != origin.json.gitCommit')
}

if (!dshVersion || typeof dshVersion !== 'string') {
  errors.push('origin.json is missing dshVersion')
} else if (['latest', 'next'].includes(dshVersion.trim().toLowerCase())) {
  errors.push(`origin.json pins floating dist-tag "${dshVersion}"; use an exact version`)
} else if (!exactDshMatch) {
  errors.push(`origin.json.dshVersion (${dshVersion}) is not an exact supported SemVer`)
}

if (dshBaseVersion && clientVersion !== dshBaseVersion) {
  errors.push(
    `HarnessDock version (${clientVersion}) must track pinned dsh base version (${dshBaseVersion}, from ${dshVersion})`,
  )
}

if (origin.clientVersion !== clientVersion) {
  errors.push(
    `origin.json.clientVersion (${origin.clientVersion}) != package.json version (${clientVersion}); run the version alignment workflow before release`,
  )
}

if (existsSync(releasedPath)) {
  const released = JSON.parse(readFileSync(releasedPath, 'utf8'))
  if (released.dshVersion !== dshVersion && released.clientVersion === clientVersion) {
    errors.push(
      `origin changed (${released.dshVersion} -> ${dshVersion}) but client version was NOT bumped (still ${clientVersion}); ` +
        `HarnessDock would keep a stale release identity. Align to the new dsh base version before release.`,
    )
  }
}

if (errors.length > 0) {
  console.error('check:release FAILED:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(
  `check:release OK: dsh=${dshVersion} dshBase=${dshBaseVersion} client=${clientVersion}${existsSync(releasedPath) ? '' : ' (no released-origin baseline yet)'}`,
)
