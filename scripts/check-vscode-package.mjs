#!/usr/bin/env node
import { existsSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = path.join(root, 'apps', 'vscode')
const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
const main = path.join(appRoot, pkg.main)
const vsix = path.join(appRoot, `harnessdock-${pkg.version}.vsix`)

for (const [label, target] of [['extension main', main], ['VSIX', vsix]]) {
  if (!existsSync(target)) throw new Error(`${label} not produced: ${path.relative(root, target)}`)
  const details = statSync(target)
  if (!details.isFile() || details.size <= 0) throw new Error(`${label} is empty: ${path.relative(root, target)}`)
}

const mainText = readFileSync(main, 'utf8')
if (!mainText.includes('HarnessDock')) throw new Error('bundled extension main does not contain HarnessDock entrypoint code')
if (statSync(vsix).size > 50 * 1024 * 1024) throw new Error(`VSIX unexpectedly exceeds 50 MiB: ${statSync(vsix).size}`)

console.log(`[vscode-package] ${pkg.main} + harnessdock-${pkg.version}.vsix produced and non-empty`)
