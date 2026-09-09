#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { finished } from 'node:stream/promises'
import { assertReleaseContract, releaseManifest, repoRoot } from './contract.mjs'

const plan = assertReleaseContract()
const inputRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release-input'))
const outputRoot = path.resolve(process.argv[3] ?? path.join(repoRoot, 'release-assets'))

function fail(message) {
  throw new Error(`[release:assemble] ${message}`)
}

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${escaped}$`)
}

function walkFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute)
    }
  }
  visit(root)
  return files
}

function copyExactlyOne(candidateArtifact, pattern, output) {
  const root = path.join(inputRoot, candidateArtifact)
  if (!existsSync(root)) fail(`candidate artifact directory is missing: ${candidateArtifact}`)
  const matcher = wildcardRegex(pattern)
  const matches = walkFiles(root).filter((file) => matcher.test(path.basename(file))).sort()
  if (matches.length !== 1) {
    fail(
      `asset must match exactly once: artifact=${candidateArtifact} pattern=${pattern} matches=${matches.length}\n` +
        matches.map((file) => `  ${path.relative(inputRoot, file)}`).join('\n'),
    )
  }
  const destination = path.join(outputRoot, output)
  copyFileSync(matches[0], destination)
  if (statSync(destination).size <= 0) fail(`assembled asset is empty: ${output}`)
  console.log(`[release:assemble] client ${candidateArtifact}/${pattern} -> ${output}`)
}

function readRuntimeManifest(root) {
  const manifestPath = path.join(root, 'manifest.json')
  if (!existsSync(manifestPath)) fail(`Runtime artifact has no root manifest.json: ${root}`)
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function verifyRuntimePayloadIdentity(runtimeAsset, root) {
  const verifierUrl = pathToFileURL(
    path.join(repoRoot, 'packages', 'client-runtime', 'src', 'image-identity.ts'),
  ).href
  const evalSource = [
    `import { assertRuntimeImageIdentity } from ${JSON.stringify(verifierUrl)};`,
    `await assertRuntimeImageIdentity(${JSON.stringify(root)});`,
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', evalSource],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.status !== 0) {
    const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    fail(
      `Runtime ${runtimeAsset.runtimeKey} payload no longer matches its sealed image identity after candidate artifact handoff` +
        (details ? `:\n${details}` : ''),
    )
  }
}

function verifyRuntimeRoot(runtimeAsset, root) {
  const manifest = readRuntimeManifest(root)
  const expected = {
    platform: runtimeAsset.platform,
    arch: runtimeAsset.arch,
    dshVersion: releaseManifest.runtime.version,
    gitTag: releaseManifest.runtime.gitTag,
    gitCommit: releaseManifest.runtime.gitCommit,
    dshGitTag: releaseManifest.runtime.gitTag,
    dshGitCommit: releaseManifest.runtime.gitCommit,
    clientVersion: releaseManifest.version,
    runtimeEmbedded: true,
    firstLaunchRuntimeDownloadRequired: false,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      fail(
        `Runtime ${runtimeAsset.runtimeKey} manifest mismatch: ${field}=${String(manifest[field] ?? 'missing')} expected ${String(value)}`,
      )
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(manifest.imageIdentity ?? ''))) {
    fail(`Runtime ${runtimeAsset.runtimeKey} has no valid imageIdentity`)
  }
  if (manifest.imageIdentityAlgorithm !== 'sha256-v1') {
    fail(`Runtime ${runtimeAsset.runtimeKey} imageIdentityAlgorithm must be sha256-v1`)
  }

  verifyRuntimePayloadIdentity(runtimeAsset, root)

  // The Windows Node distribution is extracted with node.exe at the runtime
  // root, while Unix distributions place node under bin/. Keep release
  // validation aligned with the runtime layout used by the desktop launcher.
  const nodePath = runtimeAsset.platform === 'win32'
    ? path.join(root, 'node.exe')
    : path.join(root, 'bin', 'node')
  if (!existsSync(nodePath)) fail(`Runtime ${runtimeAsset.runtimeKey} is missing bundled Node: ${nodePath}`)
  if (runtimeAsset.platform !== 'win32') chmodSync(nodePath, 0o755)
}

function resolveSourceDateEpoch() {
  const fromEnvironment = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10)
  if (Number.isInteger(fromEnvironment) && fromEnvironment > 0) return fromEnvironment

  const releaseSha = process.env.RELEASE_SHA || 'HEAD'
  const result = spawnSync('git', ['show', '-s', '--format=%ct', releaseSha], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) fail(`unable to resolve SOURCE_DATE_EPOCH for ${releaseSha}`)
  const epoch = Number.parseInt(String(result.stdout).trim(), 10)
  if (!Number.isInteger(epoch) || epoch <= 0) fail(`invalid commit timestamp for ${releaseSha}`)
  return epoch
}

async function deterministicTarGz(root, output, sourceDateEpoch) {
  const destination = path.join(outputRoot, output)
  const tar = spawn(
    'tar',
    [
      '--sort=name',
      `--mtime=@${sourceDateEpoch}`,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-C',
      root,
      '-cf',
      '-',
      '.',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const gzip = spawn('gzip', ['-n', '-9'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const outputStream = createWriteStream(destination)

  tar.stdout.pipe(gzip.stdin)
  gzip.stdout.pipe(outputStream)

  const tarExit = new Promise((resolve, reject) => {
    tar.once('error', reject)
    tar.once('close', resolve)
  })
  const gzipExit = new Promise((resolve, reject) => {
    gzip.once('error', reject)
    gzip.once('close', resolve)
  })

  const [tarCode, gzipCode] = await Promise.all([tarExit, gzipExit])
  await finished(outputStream)
  if (tarCode !== 0) fail(`tar failed for ${output} with exit code ${tarCode}`)
  if (gzipCode !== 0) fail(`gzip failed for ${output} with exit code ${gzipCode}`)
  if (!existsSync(destination) || statSync(destination).size <= 0) fail(`Runtime archive is empty: ${output}`)
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeChecksums() {
  const names = [...plan.expectedAssetNames].filter((name) => name !== plan.checksumFile).sort()
  const lines = []
  for (const name of names) {
    const file = path.join(outputRoot, name)
    if (!existsSync(file) || statSync(file).size <= 0) fail(`expected release asset missing before checksums: ${name}`)
    lines.push(`${await sha256File(file)}  ${name}`)
  }
  writeFileSync(path.join(outputRoot, plan.checksumFile), `${lines.join('\n')}\n`, 'utf8')
}

async function main() {
  if (!existsSync(inputRoot)) fail(`release input directory does not exist: ${inputRoot}`)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  for (const asset of plan.clientAssets) {
    copyExactlyOne(asset.candidateArtifact, asset.match, asset.output)
  }

  const sourceDateEpoch = resolveSourceDateEpoch()
  for (const runtimeAsset of plan.runtimeAssets) {
    const root = path.join(inputRoot, runtimeAsset.candidateArtifact)
    if (!existsSync(root) || !lstatSync(root).isDirectory()) {
      fail(`Runtime candidate artifact directory is missing: ${runtimeAsset.candidateArtifact}`)
    }
    verifyRuntimeRoot(runtimeAsset, root)
    await deterministicTarGz(root, runtimeAsset.output, sourceDateEpoch)
    console.log(`[release:assemble] Runtime ${runtimeAsset.runtimeKey} -> ${runtimeAsset.output}`)
  }

  await writeChecksums()
  const actual = readdirSync(outputRoot).sort()
  const expected = [...plan.expectedAssetNames].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`assembled asset set mismatch\nexpected=${expected.join(',')}\nactual=${actual.join(',')}`)
  }
  console.log(`[release:assemble] OK: ${actual.length} exact assets for ${plan.tag}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
