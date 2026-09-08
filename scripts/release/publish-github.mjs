#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertReleaseContract, repoRoot } from './contract.mjs'

const plan = assertReleaseContract()
const repository = process.env.GITHUB_REPOSITORY
const releaseSha = process.env.RELEASE_SHA
const releaseTag = process.env.RELEASE_TAG || plan.tag
const assetRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release-assets'))

function fail(message) {
  throw new Error(`[release:publish] ${message}`)
}

function gh(args, { allowFailure = false, binary = false } = {}) {
  const result = spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: binary ? null : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0 && !allowFailure) {
    fail(`gh ${args.join(' ')} failed (${result.status}): ${String(result.stderr ?? '').trim()}`)
  }
  return result
}

function ghJson(args, { allowMissing = false } = {}) {
  const result = gh(args, { allowFailure: allowMissing })
  if (result.status !== 0) return null
  try {
    return JSON.parse(String(result.stdout))
  } catch (error) {
    fail(`invalid JSON from gh ${args.join(' ')}: ${error.message}`)
  }
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function expectedLocalAssets() {
  if (!existsSync(assetRoot)) fail(`release asset directory is missing: ${assetRoot}`)
  const actual = readdirSync(assetRoot).filter((name) => statSync(path.join(assetRoot, name)).isFile()).sort()
  const expected = [...plan.expectedAssetNames].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`local release asset set differs from contract; expected=${expected.join(',')} actual=${actual.join(',')}`)
  }
  return actual
}

function releaseByTag() {
  return ghJson(['api', `repos/${repository}/releases/tags/${releaseTag}`], { allowMissing: true })
}

function tagSha() {
  const ref = ghJson(['api', `repos/${repository}/git/ref/tags/${releaseTag}`], { allowMissing: true })
  return ref?.object?.sha ?? null
}

function deleteReplaceablePrerelease(release, oldSha) {
  if (!plan.replaceablePrerelease) {
    fail(`tag ${releaseTag} already points to ${oldSha}; this release contract is immutable`)
  }
  if (!release) {
    fail(`tag ${releaseTag} points to ${oldSha} without a managed GitHub release; refusing to move it`)
  }
  if (release.prerelease !== true || release.draft !== false) {
    fail(`${releaseTag} is not a published prerelease; refusing to replace or move its tag`)
  }
  console.log(`[release:publish] replacing gated test prerelease ${releaseTag}: ${oldSha} -> ${releaseSha}`)
  gh(['api', '--method', 'DELETE', `repos/${repository}/releases/${release.id}`])
  gh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/tags/${releaseTag}`])
}

function createTag() {
  gh([
    'api',
    '--method',
    'POST',
    `repos/${repository}/git/refs`,
    '-f',
    `ref=refs/tags/${releaseTag}`,
    '-f',
    `sha=${releaseSha}`,
  ])
}

async function ensureExistingAssetMatches(release, assetName, localFile, compareRoot) {
  const asset = Array.isArray(release.assets) ? release.assets.find((entry) => entry.name === assetName) : null
  if (!asset) {
    gh(['release', 'upload', releaseTag, localFile])
    console.log(`[release:publish] uploaded missing same-SHA asset ${assetName}`)
    return
  }

  const localDigest = await sha256File(localFile)
  if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
    if (asset.digest !== `sha256:${localDigest}`) {
      fail(`published asset differs from exact candidate: ${assetName}`)
    }
    console.log(`[release:publish] existing asset digest matches ${assetName}`)
    return
  }

  gh(['release', 'download', releaseTag, '--pattern', assetName, '--dir', compareRoot, '--clobber'])
  const remoteFile = path.join(compareRoot, assetName)
  if (!existsSync(remoteFile)) fail(`unable to download existing asset for comparison: ${assetName}`)
  const remoteDigest = await sha256File(remoteFile)
  if (remoteDigest !== localDigest) fail(`published asset differs from exact candidate: ${assetName}`)
  console.log(`[release:publish] existing downloaded asset matches ${assetName}`)
}

function patchRelease(releaseId) {
  const notes = readFileSync(path.join(repoRoot, plan.notesPath), 'utf8')
  gh([
    'api',
    '--method',
    'PATCH',
    `repos/${repository}/releases/${releaseId}`,
    '-f',
    `target_commitish=${releaseSha}`,
    '-f',
    `name=${plan.product} ${releaseTag}`,
    '-f',
    `body=${notes}`,
    '-F',
    'draft=false',
    '-F',
    `prerelease=${plan.githubPrerelease ? 'true' : 'false'}`,
    '-f',
    `make_latest=${plan.githubPrerelease ? 'false' : 'true'}`,
  ])
}

function createRelease(assetNames) {
  const args = [
    'release',
    'create',
    releaseTag,
    ...assetNames.map((name) => path.join(assetRoot, name)),
    '--target',
    releaseSha,
    '--title',
    `${plan.product} ${releaseTag}`,
    '--notes-file',
    path.join(repoRoot, plan.notesPath),
  ]
  if (plan.githubPrerelease) args.push('--prerelease')
  gh(args)
}

async function verifyPublished(assetNames) {
  const publishedTagSha = tagSha()
  if (publishedTagSha !== releaseSha) fail(`published tag SHA ${publishedTagSha} != ${releaseSha}`)

  const release = releaseByTag()
  if (!release) fail(`GitHub release ${releaseTag} is missing after publish`)
  if (release.draft !== false) fail('published release unexpectedly remains a draft')
  if (release.prerelease !== plan.githubPrerelease) {
    fail(`published prerelease=${release.prerelease} expected ${plan.githubPrerelease}`)
  }

  const remoteAssets = (release.assets ?? []).filter((asset) => Number(asset.size) > 0).map((asset) => asset.name).sort()
  if (JSON.stringify(remoteAssets) !== JSON.stringify([...assetNames].sort())) {
    fail(`published asset set differs from contract; expected=${assetNames.sort().join(',')} actual=${remoteAssets.join(',')}`)
  }
  console.log(`[release:publish] verified ${remoteAssets.length} exact published assets on ${releaseTag} @ ${releaseSha}`)
}

async function main() {
  if (!repository) fail('GITHUB_REPOSITORY is required')
  if (!releaseSha || !/^[a-f0-9]{40}$/i.test(releaseSha)) fail('RELEASE_SHA must be an exact 40-character commit SHA')
  if (releaseTag !== plan.tag) fail(`RELEASE_TAG ${releaseTag} does not match release contract ${plan.tag}`)
  if (!existsSync(path.join(repoRoot, plan.notesPath))) fail(`release notes are missing: ${plan.notesPath}`)

  const assetNames = expectedLocalAssets()
  let release = releaseByTag()
  let existingTagSha = tagSha()

  if (existingTagSha && existingTagSha !== releaseSha) {
    deleteReplaceablePrerelease(release, existingTagSha)
    release = null
    existingTagSha = null
  }

  if (!existingTagSha) createTag()

  if (release) {
    const compareRoot = mkdtempSync(path.join(os.tmpdir(), 'harnessdock-release-compare-'))
    try {
      for (const assetName of assetNames) {
        await ensureExistingAssetMatches(release, assetName, path.join(assetRoot, assetName), compareRoot)
      }
    } finally {
      rmSync(compareRoot, { recursive: true, force: true })
    }
    patchRelease(release.id)
  } else {
    createRelease(assetNames)
  }

  await verifyPublished(assetNames)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
