#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertReleaseContract, releaseManifest } from './contract.mjs'

assertReleaseContract()

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

export function runtimeCandidateMatrix(manifest = releaseManifest) {
  return {
    include: Object.entries(manifest.runtimeBundles).map(([runtimeKey, runtime]) => ({
      runtimeKey,
      runner: requireString(runtime.prepareRunner, `runtimeBundles.${runtimeKey}.prepareRunner`),
      platform: requireString(runtime.platform, `runtimeBundles.${runtimeKey}.platform`),
      arch: requireString(runtime.arch, `runtimeBundles.${runtimeKey}.arch`),
      candidateArtifact: requireString(runtime.candidateArtifact, `runtimeBundles.${runtimeKey}.candidateArtifact`),
    })),
  }
}

export function desktopCandidateMatrix(manifest = releaseManifest) {
  return {
    include: Object.entries(manifest.targets)
      .filter(([, target]) => target.runtimeMode === 'sealed-local')
      .map(([targetId, target]) => {
        if (!Array.isArray(target.bundles) || target.bundles.length === 0) {
          throw new Error(`targets.${targetId}.bundles must list explicit Tauri bundle formats`)
        }
        const runtime = manifest.runtimeBundles[target.runtimeKey]
        if (!runtime) throw new Error(`targets.${targetId} references missing Runtime ${target.runtimeKey}`)
        return {
          targetId,
          runner: requireString(target.candidateRunner, `targets.${targetId}.candidateRunner`),
          platform: requireString(target.platform, `targets.${targetId}.platform`),
          arch: requireString(target.arch, `targets.${targetId}.arch`),
          runtimeKey: requireString(target.runtimeKey, `targets.${targetId}.runtimeKey`),
          runtimeArtifact: requireString(runtime.candidateArtifact, `runtimeBundles.${target.runtimeKey}.candidateArtifact`),
          candidateArtifact: requireString(target.candidateArtifact, `targets.${targetId}.candidateArtifact`),
          bundles: target.bundles.join(','),
        }
      }),
  }
}

export function targetCandidate(targetId, manifest = releaseManifest) {
  const target = manifest.targets?.[targetId]
  if (!target) throw new Error(`unknown release target: ${targetId}`)
  return {
    targetId,
    runner: requireString(target.candidateRunner, `targets.${targetId}.candidateRunner`),
    candidateArtifact: requireString(target.candidateArtifact, `targets.${targetId}.candidateArtifact`),
    platform: requireString(target.platform, `targets.${targetId}.platform`),
    arch: requireString(target.arch, `targets.${targetId}.arch`),
    runtimeMode: requireString(target.runtimeMode, `targets.${targetId}.runtimeMode`),
  }
}

export function targetRunner(targetId, manifest = releaseManifest) {
  return targetCandidate(targetId, manifest).runner
}

export function targetArtifact(targetId, manifest = releaseManifest) {
  return targetCandidate(targetId, manifest).candidateArtifact
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
    case 'target':
      console.log(JSON.stringify(targetCandidate(process.argv[3])))
      break
    case 'runner':
      console.log(targetRunner(process.argv[3]))
      break
    case 'artifact':
      console.log(targetArtifact(process.argv[3]))
      break
    default:
      throw new Error('usage: node scripts/release/candidate-matrix.mjs <runtime|desktop|target|runner|artifact> [TARGET_ID]')
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
