#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const releaseManifest = JSON.parse(readFileSync(path.join(repoRoot, 'release-manifest.json'), 'utf8'))

export function expandTemplate(template, values) {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('release template must be a non-empty string')
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`release template references unknown value {${key}}: ${template}`)
    return String(values[key])
  })
}

function objectEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
}

function isFlatAssetName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

export function releaseValues(manifest = releaseManifest) {
  return {
    product: manifest.product,
    version: manifest.version,
    runtimeVersion: manifest.runtime?.version,
    channel: manifest.channel,
    prerelease: manifest.prerelease ?? '',
  }
}

export function releasePlan(manifest = releaseManifest) {
  const values = releaseValues(manifest)
  const tag = expandTemplate(manifest.publication?.tagTemplate ?? 'v{version}', values)
  const clientAssets = []
  const runtimeAssets = []

  for (const [targetId, target] of objectEntries(manifest.targets)) {
    for (const asset of target.assets ?? []) {
      clientAssets.push({
        kind: 'client',
        targetId,
        platform: target.platform,
        arch: target.arch,
        runtimeMode: target.runtimeMode,
        runtimeKey: target.runtimeKey ?? null,
        candidateArtifact: target.candidateArtifact,
        match: asset.match,
        output: expandTemplate(asset.output, values),
      })
    }
  }

  for (const [runtimeKey, runtime] of objectEntries(manifest.runtimeBundles)) {
    runtimeAssets.push({
      kind: 'runtime',
      runtimeKey,
      platform: runtime.platform,
      arch: runtime.arch,
      candidateArtifact: runtime.candidateArtifact,
      output: expandTemplate(runtime.output, values),
    })
  }

  const checksumFile = manifest.checksums?.file ?? 'SHA256SUMS'
  const expectedAssetNames = [
    ...clientAssets.map((asset) => asset.output),
    ...runtimeAssets.map((asset) => asset.output),
    checksumFile,
  ]

  return {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    prerelease: manifest.prerelease,
    tag,
    notesPath: `.github/release-notes/${tag}.md`,
    githubPrerelease: Boolean(manifest.publication?.githubPrerelease),
    replaceablePrerelease: Boolean(manifest.publication?.replaceablePrerelease),
    candidateWorkflow: manifest.publication?.candidateWorkflow,
    requiredSameShaWorkflows: [...(manifest.publication?.requiredSameShaWorkflows ?? [])],
    clientAssets,
    runtimeAssets,
    checksumFile,
    checksumAlgorithm: manifest.checksums?.algorithm,
    expectedAssetNames,
    expectedAssetCount: expectedAssetNames.length,
  }
}

export function validateReleaseContract(manifest = releaseManifest) {
  const errors = []
  const add = (condition, message) => {
    if (!condition) errors.push(message)
  }

  add(manifest.schemaVersion === 2, 'release-manifest.json.schemaVersion must be 2')
  add(typeof manifest.product === 'string' && manifest.product.length > 0, 'release product is missing')
  add(/^\d+\.\d+\.\d+$/.test(String(manifest.version ?? '')), 'release version must be an exact base SemVer')
  add(['alpha', 'beta', 'rc', 'stable'].includes(manifest.channel), 'release channel must be alpha, beta, rc, or stable')
  add(typeof manifest.publication?.tagTemplate === 'string', 'publication.tagTemplate is missing')
  add(typeof manifest.publication?.candidateWorkflow === 'string', 'publication.candidateWorkflow is missing')
  add(
    Array.isArray(manifest.publication?.requiredSameShaWorkflows) && manifest.publication.requiredSameShaWorkflows.length > 0,
    'publication.requiredSameShaWorkflows must list same-SHA release gates',
  )
  if (Array.isArray(manifest.publication?.requiredSameShaWorkflows)) {
    add(
      new Set(manifest.publication.requiredSameShaWorkflows).size === manifest.publication.requiredSameShaWorkflows.length,
      'publication.requiredSameShaWorkflows must not contain duplicates',
    )
  }
  if (manifest.channel === 'stable') {
    add(manifest.publication?.githubPrerelease === false, 'stable releases cannot be GitHub prereleases')
    add(manifest.publication?.replaceablePrerelease === false, 'stable releases cannot move a replaceable prerelease tag')
  } else {
    add(manifest.publication?.githubPrerelease === true, `${manifest.channel} channel must publish as a GitHub prerelease`)
  }
  if (manifest.publication?.replaceablePrerelease) {
    add(manifest.publication?.githubPrerelease === true, 'replaceablePrerelease requires githubPrerelease=true')
  }

  add(manifest.checksums?.algorithm === 'sha256', 'checksums.algorithm must be sha256')
  add(typeof manifest.checksums?.file === 'string' && manifest.checksums.file.length > 0, 'checksums.file is missing')
  if (manifest.checksums?.file) {
    add(isFlatAssetName(manifest.checksums.file), `checksums.file must be a flat release asset name: ${manifest.checksums.file}`)
  }

  const runtimeKeys = new Set(objectEntries(manifest.runtimeBundles).map(([key]) => key))
  const referencedRuntimeKeys = new Set()
  const candidateArtifactOwners = new Map()
  const outputs = new Set()

  const registerCandidateArtifact = (artifact, owner) => {
    if (typeof artifact !== 'string' || artifact.length === 0) return
    const previous = candidateArtifactOwners.get(artifact)
    if (previous) errors.push(`candidate artifact ${artifact} is produced by both ${previous} and ${owner}`)
    else candidateArtifactOwners.set(artifact, owner)
  }

  const registerOutput = (output, owner) => {
    try {
      const resolved = expandTemplate(output, releaseValues(manifest))
      if (!isFlatAssetName(resolved)) errors.push(`${owner}: release output must be a flat asset name: ${resolved}`)
      if (outputs.has(resolved)) errors.push(`duplicate release output ${resolved} (${owner})`)
      outputs.add(resolved)
    } catch (error) {
      errors.push(`${owner}: ${error.message}`)
    }
  }

  for (const [targetId, target] of objectEntries(manifest.targets)) {
    add(typeof target.platform === 'string' && target.platform.length > 0, `${targetId}.platform is missing`)
    add(typeof target.arch === 'string' && target.arch.length > 0, `${targetId}.arch is missing`)
    add(typeof target.candidateRunner === 'string' && target.candidateRunner.length > 0, `${targetId}.candidateRunner is missing`)
    add(typeof target.candidateArtifact === 'string' && target.candidateArtifact.length > 0, `${targetId}.candidateArtifact is missing`)
    add(['sealed-local', 'remote-gateway'].includes(target.runtimeMode), `${targetId}.runtimeMode is invalid`)
    add(['installed', 'runtime-smoke', 'package-contract'].includes(target.startupGate), `${targetId}.startupGate is invalid`)
    add(Array.isArray(target.assets) && target.assets.length > 0, `${targetId}.assets must not be empty`)
    registerCandidateArtifact(target.candidateArtifact, `targets.${targetId}`)

    if (target.runtimeMode === 'sealed-local') {
      add(typeof target.runtimeKey === 'string' && runtimeKeys.has(target.runtimeKey), `${targetId} references unknown runtimeKey ${target.runtimeKey}`)
      add(Array.isArray(target.bundles) && target.bundles.length > 0, `${targetId}.bundles must list explicit desktop bundle formats`)
      if (Array.isArray(target.bundles)) {
        add(target.bundles.every((bundle) => typeof bundle === 'string' && bundle.length > 0), `${targetId}.bundles contains an invalid bundle name`)
        add(new Set(target.bundles).size === target.bundles.length, `${targetId}.bundles must not contain duplicates`)
      }
      if (target.runtimeKey) referencedRuntimeKeys.add(target.runtimeKey)
    }
    if (target.runtimeMode === 'remote-gateway') {
      add(!target.runtimeKey, `${targetId} is remote-gateway and must not declare a local runtimeKey`)
      add(!target.bundles, `${targetId} is remote-gateway and must not declare desktop Tauri bundles`)
    }

    for (const [index, asset] of (target.assets ?? []).entries()) {
      add(typeof asset.match === 'string' && asset.match.length > 0, `${targetId}.assets[${index}].match is missing`)
      add(typeof asset.output === 'string' && asset.output.length > 0, `${targetId}.assets[${index}].output is missing`)
      if (asset.output) registerOutput(asset.output, `${targetId}.assets[${index}]`)
    }
  }

  for (const [runtimeKey, runtime] of objectEntries(manifest.runtimeBundles)) {
    add(typeof runtime.platform === 'string' && runtime.platform.length > 0, `runtimeBundles.${runtimeKey}.platform is missing`)
    add(typeof runtime.arch === 'string' && runtime.arch.length > 0, `runtimeBundles.${runtimeKey}.arch is missing`)
    add(typeof runtime.prepareRunner === 'string' && runtime.prepareRunner.length > 0, `runtimeBundles.${runtimeKey}.prepareRunner is missing`)
    add(typeof runtime.candidateArtifact === 'string' && runtime.candidateArtifact.length > 0, `runtimeBundles.${runtimeKey}.candidateArtifact is missing`)
    add(typeof runtime.output === 'string' && runtime.output.length > 0, `runtimeBundles.${runtimeKey}.output is missing`)
    add(referencedRuntimeKeys.has(runtimeKey), `runtime bundle ${runtimeKey} is not referenced by any sealed-local target`)
    registerCandidateArtifact(runtime.candidateArtifact, `runtimeBundles.${runtimeKey}`)
    if (runtime.output) registerOutput(runtime.output, `runtimeBundles.${runtimeKey}`)
  }

  add(objectEntries(manifest.targets).length > 0, 'release targets are missing')
  add(objectEntries(manifest.runtimeBundles).length > 0, 'release runtimeBundles are missing')
  if (manifest.checksums?.file) {
    add(!outputs.has(manifest.checksums.file), `checksum file collides with release output ${manifest.checksums.file}`)
  }

  let plan = null
  try {
    plan = releasePlan(manifest)
  } catch (error) {
    errors.push(error.message)
  }
  if (plan) {
    add(typeof plan.tag === 'string' && plan.tag.length > 0 && !/[\s\\/]/.test(plan.tag), `release tag is unsafe: ${plan.tag}`)
    add(new Set(plan.expectedAssetNames).size === plan.expectedAssetNames.length, 'release asset names must be unique')
    add(plan.expectedAssetNames.every(isFlatAssetName), 'all release assets must be flat file names')
    add(plan.clientAssets.length > 0, 'release plan has no client assets')
    add(plan.runtimeAssets.length > 0, 'release plan has no runtime assets')
  }

  return errors
}

export function assertReleaseContract(manifest = releaseManifest) {
  const errors = validateReleaseContract(manifest)
  if (errors.length > 0) {
    throw new Error(`release contract invalid:\n${errors.map((error) => `  - ${error}`).join('\n')}`)
  }
  return releasePlan(manifest)
}

function printCommand(command) {
  const plan = assertReleaseContract()
  switch (command) {
    case 'validate':
      console.log(`release contract OK: ${plan.tag}, ${plan.expectedAssetCount} assets`)
      break
    case 'plan':
      console.log(JSON.stringify(plan, null, 2))
      break
    case 'tag':
      console.log(plan.tag)
      break
    case 'notes':
      console.log(plan.notesPath)
      break
    case 'asset-count':
      console.log(plan.expectedAssetCount)
      break
    case 'expected-assets':
      console.log(plan.expectedAssetNames.join('\n'))
      break
    case 'candidate-workflow':
      console.log(plan.candidateWorkflow)
      break
    case 'required-workflows':
      console.log(plan.requiredSameShaWorkflows.join('\n'))
      break
    case 'github-prerelease':
      console.log(plan.githubPrerelease ? 'true' : 'false')
      break
    case 'replaceable':
      console.log(plan.replaceablePrerelease ? 'true' : 'false')
      break
    default:
      throw new Error(`unknown release contract command: ${command}`)
  }

  if (command === 'validate' && !existsSync(path.join(repoRoot, plan.notesPath))) {
    throw new Error(`release notes missing: ${plan.notesPath}`)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    printCommand(process.argv[2] ?? 'validate')
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
