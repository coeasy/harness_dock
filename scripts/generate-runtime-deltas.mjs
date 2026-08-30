#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const currentDir = path.resolve(args['current-dir'] ?? 'artifacts')
const previousDir = path.resolve(args['previous-dir'] ?? 'previous-runtime')
const outDir = path.resolve(args['out-dir'] ?? currentDir)
const maxRatio = Number(args['max-ratio'] ?? '0.75')

if (!(maxRatio > 0 && maxRatio < 1)) throw new Error(`--max-ratio must be between 0 and 1, got ${maxRatio}`)
await mkdir(outDir, { recursive: true })

const current = await runtimeArchives(currentDir)
const previous = await runtimeArchives(previousDir)
let generated = 0
for (const target of current) {
  const baseCandidates = previous
    .filter((item) => item.platform === target.platform && item.arch === target.arch)
    .sort((a, b) => a.version.localeCompare(b.version))
  const base = baseCandidates.at(-1)
  if (!base || base.version === target.version) continue
  const result = await generateDelta(base, target)
  if (result) generated += 1
}
console.log(`runtime deltas generated: ${generated}`)

async function generateDelta(base, target) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-runtime-delta-build-'))
  const fromRoot = path.join(temp, 'from')
  const toRoot = path.join(temp, 'to')
  const deltaRoot = path.join(temp, 'delta')
  const overlayRoot = path.join(deltaRoot, 'overlay')
  try {
    await Promise.all([mkdir(fromRoot), mkdir(toRoot), mkdir(overlayRoot, { recursive: true })])
    await Promise.all([
      execFileAsync('tar', ['-xzf', base.file, '-C', fromRoot], { maxBuffer: 16 * 1024 * 1024 }),
      execFileAsync('tar', ['-xzf', target.file, '-C', toRoot], { maxBuffer: 16 * 1024 * 1024 }),
    ])

    const [fromIndex, toIndex] = await Promise.all([treeIndex(fromRoot), treeIndex(toRoot)])
    const deletes = [...fromIndex.keys()].filter((key) => !toIndex.has(key))
    let overlayFiles = 0
    for (const [relative, targetRecord] of toIndex) {
      const baseRecord = fromIndex.get(relative)
      if (baseRecord && sameRecord(baseRecord, targetRecord)) continue
      if (baseRecord && baseRecord.kind !== targetRecord.kind) deletes.push(relative)
      const source = resolveInside(toRoot, relative)
      const destination = resolveInside(overlayRoot, relative)
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(source, destination, {
        recursive: true,
        force: true,
        dereference: false,
        verbatimSymlinks: true,
      })
      overlayFiles += 1
    }

    const fromTreeSha256 = treeDigest(fromIndex)
    const toTreeSha256 = treeDigest(toIndex)
    const manifest = {
      schemaVersion: 1,
      fromVersion: base.version,
      toVersion: target.version,
      platform: target.platform,
      arch: target.arch,
      fromTreeSha256,
      toTreeSha256,
      delete: [...new Set(deletes)].sort(),
    }
    await writeFile(
      path.join(deltaRoot, 'delta-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )

    const assetName = `HarnessDock-runtime-delta-${base.version}_to_${target.version}-${target.platform}-${target.arch}.tar.gz`
    const output = path.join(outDir, assetName)
    await execFileAsync('tar', ['-czf', output, '-C', deltaRoot, 'delta-manifest.json', 'overlay'], {
      maxBuffer: 16 * 1024 * 1024,
    })
    const deltaSize = (await stat(output)).size
    const fullSize = (await stat(target.file)).size
    const ratio = fullSize > 0 ? deltaSize / fullSize : 1
    if (ratio >= maxRatio) {
      await rm(output, { force: true })
      console.log(
        `skip runtime delta ${target.platform}/${target.arch} ${base.version} -> ${target.version}: ` +
          `${deltaSize} bytes is ${(ratio * 100).toFixed(1)}% of full (${(maxRatio * 100).toFixed(0)}% max)`,
      )
      return false
    }

    const meta = {
      schemaVersion: 1,
      component: 'runtime',
      fromVersion: base.version,
      toVersion: target.version,
      platform: target.platform,
      arch: target.arch,
      format: 'runtime-overlay-tar.gz',
      assetName,
      sha256: await sha256File(output),
      size: deltaSize,
      fullSize,
      ratio,
      fromTreeSha256,
      toTreeSha256,
      changedEntries: overlayFiles,
      deletedEntries: manifest.delete.length,
    }
    await writeFile(`${output}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    console.log(
      `runtime delta ${target.platform}/${target.arch} ${base.version} -> ${target.version}: ` +
        `${deltaSize}/${fullSize} bytes (${(ratio * 100).toFixed(1)}%)`,
    )
    return true
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function runtimeArchives(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const result = []
  for (const name of names) {
    const match = /^HarnessDock-runtime-(.+)-(win32|darwin|linux)-(x64|arm64)\.tar\.gz$/.exec(name)
    if (!match) continue
    result.push({ file: path.join(dir, name), version: match[1], platform: match[2], arch: match[3] })
  }
  return result
}

async function treeIndex(root) {
  const index = new Map()
  await visit('')
  return index

  async function visit(relativeDir) {
    const dir = relativeDir ? resolveInside(root, relativeDir) : root
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!relativeDir && entry.name === '.ready') continue
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const safe = safeRelativePath(relative)
      const absolute = resolveInside(root, safe)
      const details = await lstat(absolute)
      if (details.isDirectory()) {
        await visit(safe)
      } else if (details.isSymbolicLink()) {
        index.set(safe, { kind: 'link', target: await readlink(absolute) })
      } else if (details.isFile()) {
        index.set(safe, { kind: 'file', size: details.size, sha256: await sha256File(absolute) })
      } else {
        throw new Error(`unsupported runtime entry: ${safe}`)
      }
    }
  }
}

function sameRecord(left, right) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'link') return left.target === right.target
  return left.size === right.size && left.sha256 === right.sha256
}

function treeDigest(index) {
  const records = [...index.entries()]
    .map(([relative, value]) =>
      value.kind === 'link'
        ? `L\t${relative}\t${value.target}`
        : `F\t${relative}\t${value.size}\t${value.sha256}`,
    )
    .sort()
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

function safeRelativePath(value) {
  const normalized = value.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe runtime path: ${value}`)
  }
  return normalized
}

function resolveInside(root, relative) {
  const safe = safeRelativePath(relative)
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, ...safe.split('/'))
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`runtime path escapes root: ${relative}`)
  }
  return resolved
}

async function sha256File(file) {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`)
    result[key.slice(2)] = value
    index += 1
  }
  return result
}
