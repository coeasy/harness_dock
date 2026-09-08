#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertReleaseContract, releaseManifest } from './contract.mjs'

assertReleaseContract()

export function runtimeCandidateMatrix(manifest = releaseManifest) {
  return {
    include: Object.entries(manifest.runtimeBundles).map(([runtimeKey, runtime]) => ({
      runtimeKey,
      runner: runtime.prepareRunner,
      platform: runtime.platform,
      arch: runtime.arch,
      candidateArtifact: runtime.candidateArtifact,
    })),
  }
}

export function desktopCandidateMatrix(manifest = releaseManifest) {
  return {
    include: Object.entries(manifest.targets)
      .filter(([, target]) => target.runtimeMode === 'sealed-local')
      .map(([targetId, target]) => ({
        targetId,
        runner: target.candidateRunner,
        platform: target.platform,
        arch: target.arch,
        runtimeKey: target.runtimeKey,
        runtimeArtifact: manifest.runtimeBundles[target.runtimeKey]?.candidateArtifact,
        candidateArtifact: target.candidateArtifact,
        bundles: target.bundles.join(','),
      })),
  }
}

export function targetRunner(targetId, manifest = releaseManifest) {
  const target = manifest.targets?.[targetId]
  if (!target) throw new Error(`unknown release target: ${targetId}`)
  if (!target.candidateRunner) throw new Error(`release target ${targetId} has no candidateRunner`)
  return target.candidateRunner
}

function main() {
  const command = process.argv[2]
  switch (command) {
    case 'runtime':
      console.log(JSON.stringify(runtimeCandidateMatrix()))
      break
    case 'desktop':
      console.log(JSON.stringify(desktopCandidateMatrix()))
      break
    case 'runner':
      console.log(targetRunner(process.argv[3]))
      break
    default:
      throw new Error('usage: node scripts/release/candidate-matrix.mjs <runtime|desktop|runner TARGET_ID>')
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
