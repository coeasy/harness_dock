#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages', 'plugin-harness-shell')
const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}))?.[0]
if (!packed) throw new Error('npm pack --dry-run did not return a package description')
if (packed.name !== '@dsh/plugin-harness-shell') throw new Error(`unexpected package name: ${packed.name}`)
if (packed.version !== packageJson.version) throw new Error(`package version drift: ${packed.version} != ${packageJson.version}`)
const files = new Set((packed.files ?? []).map((file) => file.path))
for (const required of ['package.json', 'manifest.json', 'lib/index.js', 'web/shell.js']) {
  if (!files.has(required)) throw new Error(`publishable Harness Shell is missing ${required}`)
}
for (const file of files) {
  if (file.startsWith('node_modules/') || file.includes('/node_modules/')) throw new Error(`node_modules leaked into shell package: ${file}`)
  if (file.includes('src-tauri/') || /\.(exe|dmg|appimage|deb|aab|apk)$/i.test(file)) throw new Error(`host binary leaked into shell package: ${file}`)
}
if (!Number.isFinite(packed.size) || packed.size <= 0 || packed.size > 512 * 1024) {
  throw new Error(`unexpected Harness Shell packed size: ${packed.size}`)
}
console.log(`[shell-package] ${packed.name}@${packed.version}: ${packed.size} bytes, ${files.size} files; publish contract passes.`)
