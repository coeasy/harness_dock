#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { assertReleaseContract, repoRoot } from './contract.mjs'

const plan = assertReleaseContract()
const assetRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, 'release-assets'))

function fail(message) {
  throw new Error(`[release:verify-assets] ${message}`)
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  if (!existsSync(assetRoot)) fail(`asset directory does not exist: ${assetRoot}`)

  const actualNames = readdirSync(assetRoot)
    .filter((name) => statSync(path.join(assetRoot, name)).isFile())
    .sort()
  const expectedNames = [...plan.expectedAssetNames].sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const expected = new Set(expectedNames)
    const actual = new Set(actualNames)
    const missing = expectedNames.filter((name) => !actual.has(name))
    const unexpected = actualNames.filter((name) => !expected.has(name))
    fail(`asset set mismatch; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`)
  }

  for (const name of actualNames) {
    const size = statSync(path.join(assetRoot, name)).size
    if (size <= 0) fail(`asset is empty: ${name}`)
  }

  const checksumPath = path.join(assetRoot, plan.checksumFile)
  const checksumLines = readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const publishedDigests = new Map()
  for (const line of checksumLines) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
    if (!match) fail(`invalid ${plan.checksumFile} line: ${line}`)
    if (publishedDigests.has(match[2])) fail(`duplicate checksum entry: ${match[2]}`)
    publishedDigests.set(match[2], match[1].toLowerCase())
  }

  const payloadNames = expectedNames.filter((name) => name !== plan.checksumFile).sort()
  if (publishedDigests.size !== payloadNames.length) {
    fail(`${plan.checksumFile} entry count ${publishedDigests.size} != payload count ${payloadNames.length}`)
  }

  for (const name of payloadNames) {
    const expectedDigest = publishedDigests.get(name)
    if (!expectedDigest) fail(`${plan.checksumFile} is missing ${name}`)
    const actualDigest = await sha256File(path.join(assetRoot, name))
    if (actualDigest !== expectedDigest) fail(`SHA-256 mismatch for ${name}: expected ${expectedDigest}, got ${actualDigest}`)
  }

  console.log(`[release:verify-assets] OK: ${plan.expectedAssetCount} exact non-empty assets, all payload digests verified`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
