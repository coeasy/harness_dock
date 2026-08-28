#!/usr/bin/env node
/**
 * Build the VSIX artifact with the version taken from apps/vscode/package.json
 * (single source of truth) instead of a hard-coded harnessdock-0.1.0.vsix.
 *
 * Equivalent to the previous pack:vsix chain:
 *   node ./scripts/copy-resources.mjs && pnpm bundle &&
 *   vsce package --allow-missing-repository --no-dependencies --out harnessdock-<version>.vsix
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

await run(process.execPath, ['scripts/copy-resources.mjs'])
await run('pnpm', ['bundle'])
await run('vsce', [
  'package',
  '--allow-missing-repository',
  '--no-dependencies',
  '--out',
  `harnessdock-${version}.vsix`,
])
console.log(`packed harnessdock-${version}.vsix`)
