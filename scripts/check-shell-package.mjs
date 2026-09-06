#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages', 'plugin-harness-shell')
const readJson = (relative) => JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'))
const packageJson = readJson('packages/plugin-harness-shell/package.json')
const pluginManifest = readJson('packages/plugin-harness-shell/manifest.json')
const shellContract = readJson('protocol/shell-contract.json')
const releaseManifest = readJson('release-manifest.json')

execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'generate-shell-contract.mjs'), '--check'], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (pluginManifest.id !== shellContract.pluginId) {
  throw new Error(`shell manifest plugin id drift: ${pluginManifest.id} != ${shellContract.pluginId}`)
}
if (pluginManifest.version !== packageJson.version) {
  throw new Error(`shell manifest version drift: ${pluginManifest.version} != ${packageJson.version}`)
}
if (pluginManifest.apiVersion !== shellContract.apiVersion) {
  throw new Error(`shell manifest apiVersion drift: ${pluginManifest.apiVersion} != ${shellContract.apiVersion}`)
}
if (releaseManifest.shell?.apiVersion !== shellContract.apiVersion) {
  throw new Error(`release shell apiVersion drift: ${releaseManifest.shell?.apiVersion} != ${shellContract.apiVersion}`)
}
if (releaseManifest.shell?.version !== packageJson.version) {
  throw new Error(`release shell version drift: ${releaseManifest.shell?.version} != ${packageJson.version}`)
}

const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
const npmCandidates = buildNpmCandidates(process.execPath)
let packed
let lastError = null
for (const candidate of npmCandidates) {
  try {
    const output = execFileSync(candidate.command, candidate.args, {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    packed = JSON.parse(output)?.[0]
    lastError = null
  } catch (error) {
    lastError = error
  }
  if (packed) break
}
if (!packed) {
  throw new Error(
    `npm pack could not run. Tried: ${npmCandidates.map((entry) => entry.label).join(', ')} ` +
      `— last error: ${lastError?.code ?? lastError?.message}`,
  )
}
if (packed.name !== '@dsh/plugin-harness-shell') throw new Error(`unexpected package name: ${packed.name}`)
if (packed.version !== packageJson.version) throw new Error(`package version drift: ${packed.version} != ${packageJson.version}`)
const files = new Set((packed.files ?? []).map((file) => file.path))
for (const required of [
  'package.json',
  'manifest.json',
  'lib/index.js',
  'web/shell.js',
  'src/shell-contract.generated.ts',
]) {
  if (!files.has(required)) throw new Error(`publishable Harness Shell is missing ${required}`)
}
for (const file of files) {
  if (file.startsWith('node_modules/') || file.includes('/node_modules/')) throw new Error(`node_modules leaked into shell package: ${file}`)
  if (file.includes('src-tauri/') || /\.(exe|dmg|appimage|deb|aab|apk)$/i.test(file)) throw new Error(`host binary leaked into shell package: ${file}`)
}
if (!Number.isFinite(packed.size) || packed.size <= 0 || packed.size > 512 * 1024) {
  throw new Error(`unexpected Harness Shell packed size: ${packed.size}`)
}

console.log(
  `[shell-package] ${packed.name}@${packed.version}: ${packed.size} bytes, ${files.size} files; ` +
    `apiVersion ${shellContract.apiVersion}; ${shellContract.commands.length} canonical commands; publish contract passes.`,
)

function buildNpmCandidates(nodePath) {
  const candidates = []
  const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    candidates.push({ label: `node ${npmCli}`, command: nodePath, args: [npmCli, ...npmArgs] })
  }
  candidates.push({ label: 'npm', command: 'npm', args: [...npmArgs] })
  if (process.platform === 'win32') {
    candidates.push({ label: 'npm.cmd', command: 'npm.cmd', args: [...npmArgs] })
  }
  return candidates
}
