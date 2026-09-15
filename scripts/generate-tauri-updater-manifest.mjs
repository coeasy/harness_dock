#!/usr/bin/env node
/**
 * Assemble the static manifest consumed by the Tauri updater.
 *
 * The desktop candidate jobs upload the signed platform artifacts. This
 * script deliberately maps only the four desktop targets supported by the
 * signed updater and fails closed if any signature is missing or empty.
 * Mobile packages and the Linux .deb remain ordinary release assets and are
 * not updater targets.
 *
 * Usage:
 *   node scripts/generate-tauri-updater-manifest.mjs [assets-dir] [tag]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = path.resolve(repoRoot, process.argv[2] || 'release-assets')
const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const version = rootPackage.version
const tag = process.argv[3] || `v${version}`

if (tag !== `v${version}`) {
  throw new Error(`updater tag must be v${version}, got ${tag}`)
}

const releaseBase = `https://github.com/coeasy/harness_dock/releases/download/${tag}`
const targets = {
  'windows-x86_64': `HarnessDock-${version}-windows-x64-setup.exe`,
  'linux-x86_64': `HarnessDock-${version}-linux-x64.AppImage`,
  'darwin-x86_64': `HarnessDock-${version}-macos-x64.app.tar.gz`,
  'darwin-aarch64': `HarnessDock-${version}-macos-arm64.app.tar.gz`,
}

const readRequiredSignature = async (assetName) => {
  const signatureName = `${assetName}.sig`
  const signature = (await readFile(path.join(assetsDir, signatureName), 'utf8')).trim()
  if (!signature) throw new Error(`empty Tauri updater signature: ${signatureName}`)
  return signature
}

const platforms = {}
for (const [platform, assetName] of Object.entries(targets)) {
  const signature = await readRequiredSignature(assetName)
  platforms[platform] = {
    url: `${releaseBase}/${assetName}`,
    signature,
  }
}

const notesPath = path.join(repoRoot, '.github', 'release-notes', `${tag}.md`)
const notes = await readFile(notesPath, 'utf8')
const pubDate = process.env.TAURI_UPDATER_PUB_DATE || new Date().toISOString()
const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
}

await mkdir(assetsDir, { recursive: true })
await writeFile(path.join(assetsDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`generated signed Tauri updater manifest for ${tag}`)
