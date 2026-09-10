#!/usr/bin/env node
/**
 * Release discipline gate for HarnessDock + pinned DeepSeek Harness Runtime.
 *
 * This validates provenance/version alignment and the complete platform release
 * contract before candidate or publish workflows are allowed to proceed.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_BUILD_TARGETS } from './build-targets.mjs'
import {
  releaseManifest as manifest,
  releasePlan,
  validateReleaseContract,
} from './release/contract.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const origin = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), 'utf8'),
)
const releasedPath = path.join(repoRoot, 'packages', 'docs-sync', 'released-origin.json')

const errors = [...validateReleaseContract(manifest)]
const clientVersion = rootPkg.version
const { dshVersion } = origin
const exactDshMatch =
  typeof dshVersion === 'string'
    ? dshVersion.trim().match(/^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/)
    : null

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

// HarnessDock is a wrapper client, so its release identity may advance for
// host/UI fixes without waiting for a new dsh base version. The exact dsh
// provenance remains enforced above; when that provenance changes, the
// released-origin guard below still requires a new client release identity.

if (origin.clientVersion !== clientVersion) {
  errors.push(
    `origin.json.clientVersion (${origin.clientVersion}) != package.json version (${clientVersion}); run the version alignment workflow before release`,
  )
}

// Desktop local builds and release candidates must describe the same native
// host target. Release CI may add wrappers such as DMG around the canonical app,
// but platform, arch, Runtime, runner, and Tauri bundle policy cannot drift.
const desktopProfiles = Object.values(DESKTOP_BUILD_TARGETS)
for (const buildTarget of desktopProfiles) {
  const releaseTarget = manifest.targets?.[buildTarget.id]
  if (!releaseTarget) {
    errors.push(`release-manifest.json.targets is missing desktop build target ${buildTarget.id}`)
    continue
  }
  if (releaseTarget.platform !== buildTarget.platform) {
    errors.push(`${buildTarget.id}.platform (${releaseTarget.platform}) != build target (${buildTarget.platform})`)
  }
  if (releaseTarget.arch !== buildTarget.arch) {
    errors.push(`${buildTarget.id}.arch (${releaseTarget.arch}) != build target (${buildTarget.arch})`)
  }
  if (releaseTarget.runtimeMode !== 'sealed-local') {
    errors.push(`${buildTarget.id}.runtimeMode must be sealed-local`)
  }
  if (releaseTarget.runtimeKey !== buildTarget.runtimeKey) {
    errors.push(`${buildTarget.id}.runtimeKey (${releaseTarget.runtimeKey}) != build target (${buildTarget.runtimeKey})`)
  }
  if (releaseTarget.candidateRunner !== buildTarget.ciRunner) {
    errors.push(`${buildTarget.id}.candidateRunner (${releaseTarget.candidateRunner}) != build target (${buildTarget.ciRunner})`)
  }
  if (JSON.stringify(releaseTarget.bundles ?? []) !== JSON.stringify(buildTarget.bundles)) {
    errors.push(
      `${buildTarget.id}.bundles (${(releaseTarget.bundles ?? []).join(',')}) != build target (${buildTarget.bundles.join(',')})`,
    )
  }

  const runtimeBundle = manifest.runtimeBundles?.[buildTarget.runtimeKey]
  if (!runtimeBundle) {
    errors.push(`release-manifest.json.runtimeBundles is missing ${buildTarget.runtimeKey}`)
  } else {
    if (runtimeBundle.platform !== buildTarget.platform) {
      errors.push(`runtime ${buildTarget.runtimeKey}.platform (${runtimeBundle.platform}) != ${buildTarget.platform}`)
    }
    if (runtimeBundle.arch !== buildTarget.arch) {
      errors.push(`runtime ${buildTarget.runtimeKey}.arch (${runtimeBundle.arch}) != ${buildTarget.arch}`)
    }
    if (typeof runtimeBundle.prepareRunner !== 'string' || runtimeBundle.prepareRunner.length === 0) {
      errors.push(`runtime ${buildTarget.runtimeKey}.prepareRunner is missing`)
    }
  }
}

for (const [targetId, target] of Object.entries(manifest.targets ?? {})) {
  if (typeof target.candidateRunner !== 'string' || target.candidateRunner.length === 0) {
    errors.push(`${targetId}.candidateRunner is missing`)
  }
  if (target.platform === 'android' || target.platform === 'ios') {
    if (target.runtimeMode !== 'remote-gateway') {
      errors.push(`${targetId} mobile release target must use remote-gateway Runtime mode`)
    }
    if (target.runtimeKey) {
      errors.push(`${targetId} mobile release target must not package a desktop Runtime`)
    }
  }
}

if (existsSync(releasedPath)) {
  const released = JSON.parse(readFileSync(releasedPath, 'utf8'))
  if (released.dshVersion !== dshVersion && released.clientVersion === clientVersion) {
    errors.push(
      `origin changed (${released.dshVersion} -> ${dshVersion}) but client version was NOT bumped (still ${clientVersion}); ` +
        `HarnessDock would keep a stale release identity. Bump the client release version before release.`,
    )
  }
}

let plan = null
try {
  plan = releasePlan(manifest)
  if (!existsSync(path.join(repoRoot, plan.notesPath))) {
    errors.push(`release notes are missing for contract tag ${plan.tag}: ${plan.notesPath}`)
  }
} catch (error) {
  errors.push(`unable to build release plan: ${error.message}`)
}

if (errors.length > 0) {
  console.error('check:release FAILED:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(
  `check:release OK: tag=${plan.tag} channel=${manifest.channel} assets=${plan.expectedAssetCount} ` +
    `dsh=${dshVersion} client=${clientVersion}${existsSync(releasedPath) ? '' : ' (no released-origin baseline yet)'}`,
)
