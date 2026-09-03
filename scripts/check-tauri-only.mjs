import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = (message) => {
  throw new Error(`[tauri-only] ${message}`)
}

const forbiddenPaths = [
  'apps/desktop',
  'apps/electron',
  'electron',
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.json',
]
for (const relative of forbiddenPaths) {
  if (existsSync(path.join(root, relative))) fail(`obsolete Electron path exists: ${relative}`)
}

const ignoredDirs = new Set(['.git', 'node_modules', 'target', 'dist', 'coverage', '.turbo'])
const manifestFiles = []
const activeFiles = []
const activeRoots = ['apps', 'packages', 'scripts', '.github/workflows']
const activeExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.rs', '.toml', '.yml', '.yaml', '.json'])

function walk(directory, collector, predicate = () => true) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory)) {
    if (ignoredDirs.has(entry)) continue
    const absolute = path.join(directory, entry)
    const stat = statSync(absolute)
    if (stat.isDirectory()) walk(absolute, collector, predicate)
    else if (predicate(absolute)) collector.push(absolute)
  }
}

walk(root, manifestFiles, (absolute) => path.basename(absolute) === 'package.json')
for (const activeRoot of activeRoots) {
  walk(path.join(root, activeRoot), activeFiles, (absolute) => {
    const relative = path.relative(root, absolute).replaceAll('\\', '/')
    if (relative === 'scripts/check-tauri-only.mjs') return false
    if (relative.endsWith('pnpm-lock.yaml') || relative.endsWith('Cargo.lock')) return false
    return activeExtensions.has(path.extname(absolute))
  })
}

const forbiddenPackages = (name) =>
  name === 'electron' ||
  name === 'electron-builder' ||
  name.startsWith('@electron/') ||
  name.startsWith('electron-')

for (const manifestPath of manifestFiles) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] || {})) {
      if (forbiddenPackages(name)) {
        fail(`${path.relative(root, manifestPath)} contains forbidden package ${name}`)
      }
    }
  }
  for (const [name, script] of Object.entries(manifest.scripts || {})) {
    if (/\belectron(?:-builder)?\b/i.test(script)) {
      fail(`${path.relative(root, manifestPath)} script ${name} invokes Electron tooling`)
    }
  }
}

const forbiddenSourcePatterns = [
  [/from\s+['"]electron(?:\/|['"])/i, 'Electron import'],
  [/require\(\s*['"]electron(?:\/|['"])/i, 'Electron require'],
  [/\belectron-builder\b/i, 'electron-builder reference'],
  [/\bBrowserWindow\b.*\belectron\b/i, 'Electron BrowserWindow reference'],
]

for (const absolute of activeFiles) {
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const source = readFileSync(absolute, 'utf8')
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(source)) fail(`${relative} contains ${label}`)
  }
}

console.log('[tauri-only] active product, package and workflow paths are Electron-free')
