#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    source: { type: 'string', multiple: true },
    out: { type: 'string' },
    entry: { type: 'string', default: '@deepseek-ai/dsh' },
  },
})

if (!values.source?.length || !values.out) {
  throw new Error('usage: node scripts/select-runtime-packs.mjs --source <dir> [--source <dir> ...] --out <dir>')
}

function listTarballs(root) {
  const result = []
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, item.name)
      if (item.isDirectory()) visit(absolute)
      else if (item.isFile() && item.name.endsWith('.tgz')) result.push(absolute)
    }
  }
  visit(path.resolve(root))
  return result
}

function readPackedPackage(tarball) {
  const raw = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  const pkg = JSON.parse(raw)
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error(`packed tarball has no package identity: ${tarball}`)
  }
  return pkg
}

const packed = new Map()
for (const tarball of values.source.flatMap(listTarballs).sort()) {
  const pkg = readPackedPackage(tarball)
  if (packed.has(pkg.name)) throw new Error(`duplicate packed package ${pkg.name}`)
  packed.set(pkg.name, { tarball, pkg })
}

const entryName = values.entry
if (!packed.has(entryName)) throw new Error(`packed runtime does not contain ${entryName}`)

const selected = new Set()
const pending = [entryName]
while (pending.length > 0) {
  const name = pending.pop()
  if (selected.has(name)) continue
  const current = packed.get(name)
  if (!current) continue
  selected.add(name)

  const required = new Set(Object.keys(current.pkg.dependencies ?? {}))
  for (const peerName of Object.keys(current.pkg.peerDependencies ?? {})) {
    if (current.pkg.peerDependenciesMeta?.[peerName]?.optional === true) continue
    required.add(peerName)
  }
  for (const dependencyName of required) {
    if (packed.has(dependencyName) && !selected.has(dependencyName)) pending.push(dependencyName)
  }
}

const out = path.resolve(values.out)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const basenames = new Set()
for (const name of [...selected].sort()) {
  const source = packed.get(name).tarball
  const basename = path.basename(source)
  if (basenames.has(basename)) throw new Error(`duplicate runtime pack filename ${basename}`)
  basenames.add(basename)
  copyFileSync(source, path.join(out, basename))
}

const excluded = [...packed.keys()].filter((name) => !selected.has(name)).sort()
console.log(`[runtime-packs] selected ${selected.size}/${packed.size} required pack(s) for ${entryName}`)
if (excluded.length > 0) console.log(`[runtime-packs] excluded ${excluded.length}: ${excluded.join(', ')}`)
