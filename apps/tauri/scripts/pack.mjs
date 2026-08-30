#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  releaseArtifactName,
  runtimeNodeRelative,
  tauriBundleKinds,
} from './pack-plan.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const srcTauriRoot = path.join(appRoot, 'src-tauri')
const runtimeStage = path.join(srcTauriRoot, 'resources', 'runtime')
const runtimeRoot = path.join(repoRoot, 'runtimes', 'pack')
const bundleRoot = path.join(srcTauriRoot, 'target', 'release', 'bundle')

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'full' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log('Usage: node apps/tauri/scripts/pack.mjs --scenario full')
  process.exit(0)
}
if (values.scenario !== 'full') {
  throw new Error('Tauri v0.2 packaging currently promotes the deterministic full scenario first; thin packaging is M2b.')
}

const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const origin = JSON.parse(await readFile(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), 'utf8'))
const versions = JSON.parse(await readFile(path.join(appRoot, 'versions.json'), 'utf8'))
const platform = process.platform
const arch = process.arch
const bundles = tauriBundleKinds(platform)
const releaseRoot = path.join(appRoot, 'release', 'full')

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[tauri-pack] ${command} ${args.join(' ')}`)
    const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function requireFile(file, label) {
  if (!(await exists(file))) throw new Error(`${label} is missing: ${file}`)
}

async function stageFullRuntime() {
  await rm(runtimeStage, { recursive: true, force: true })
  await mkdir(runtimeStage, { recursive: true })

  const node = path.join(runtimeRoot, runtimeNodeRelative(platform))
  const dsh = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const runtimeManifestPath = path.join(runtimeRoot, 'manifest.json')
  await requireFile(node, 'bundled Node')
  await requireFile(dsh, 'bundled dsh')
  await requireFile(runtimeManifestPath, 'runtime manifest')

  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'))
  if (runtimeManifest.dshVersion !== origin.dshVersion) {
    throw new Error(
      `prepared runtime dsh ${runtimeManifest.dshVersion ?? '<unknown>'} != pinned ${origin.dshVersion}`,
    )
  }

  await cp(path.join(appRoot, 'dist', 'runtime-bridge.mjs'), path.join(runtimeStage, 'runtime-bridge.mjs'))
  await cp(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), path.join(runtimeStage, 'origin.json'))
  await cp(
    path.join(repoRoot, 'packages', 'plugin-embedded-client', 'lib'),
    path.join(runtimeStage, 'plugin'),
    { recursive: true },
  )
  await cp(runtimeRoot, path.join(runtimeStage, 'dsh-runtime'), { recursive: true })

  const hostManifest = {
    schemaVersion: 1,
    clientVersion: rootPackage.version,
    host: 'tauri-desktop',
    channel: 'next',
    releaseRole: 'default',
    appId: 'com.dsh.client.tauri.next',
    scenario: 'full',
    platform,
    arch,
    dshVersion: origin.dshVersion,
    nodeVersion: runtimeManifest.nodeVersion,
    tauriCore: versions.tauriCore,
    tauriCli: versions.tauriCli,
  }
  await writeFile(
    path.join(runtimeStage, 'host-manifest.json'),
    `${JSON.stringify(hostManifest, null, 2)}\n`,
    'utf8',
  )
  return hostManifest
}

async function walkFiles(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await walkFiles(full)))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

function isInstaller(file) {
  const lower = file.toLowerCase()
  if (platform === 'win32') return lower.endsWith('.exe')
  if (platform === 'darwin') return lower.endsWith('.dmg')
  return lower.endsWith('.appimage') || lower.endsWith('.deb')
}

async function hashFile(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

async function collectArtifacts(hostManifest) {
  await requireFile(bundleRoot, 'Tauri bundle output')
  const installers = (await walkFiles(bundleRoot)).filter(isInstaller)
  if (installers.length === 0) {
    throw new Error(`Tauri produced no installable ${bundles.join(',')} artifacts under ${bundleRoot}`)
  }
  await rm(releaseRoot, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })
  const hashes = []
  for (const source of installers) {
    const extension = source.toLowerCase().endsWith('.appimage') ? '.AppImage' : path.extname(source)
    const filename = releaseArtifactName({ version: rootPackage.version, platform, arch, extension })
    const target = path.join(releaseRoot, filename)
    await cp(source, target)
    hashes.push(`${await hashFile(target)}  ${filename}`)
  }
  await writeFile(path.join(releaseRoot, 'SHA256SUMS'), `${hashes.sort().join('\n')}\n`, 'utf8')
  await writeFile(
    path.join(releaseRoot, 'host-manifest.json'),
    `${JSON.stringify(hostManifest, null, 2)}\n`,
    'utf8',
  )
  console.log(`[tauri-pack] release artifacts: ${releaseRoot}`)
}

try {
  await run('pnpm', ['--filter', '@dsh/plugin-embedded-client', 'bundle'], repoRoot)
  await run('pnpm', ['build:tauri-bridge'], repoRoot)

  if (process.env.DSH_SKIP_RUNTIME_PREPARE !== '1') {
    await run(
      'pnpm',
      ['--filter', '@dsh/client-runtime', 'bundle-runtime'],
      repoRoot,
      {
        DSH_RUNTIME_PLATFORM: platform,
        DSH_RUNTIME_ARCH: arch,
        DSH_RUNTIME_DIR: path.relative(repoRoot, runtimeRoot),
      },
    )
  } else {
    console.log('[tauri-pack] using cached prepared runtime')
  }

  const hostManifest = await stageFullRuntime()
  await rm(path.join(srcTauriRoot, 'generated-icons'), { recursive: true, force: true })
  await run(
    process.execPath,
    [
      path.join(appRoot, 'scripts', 'tauri-cli.mjs'),
      'icon',
      '../desktop/build/icons/1024x1024.png',
      '--output',
      'src-tauri/generated-icons',
    ],
    appRoot,
  )
  await rm(bundleRoot, { recursive: true, force: true })
  await run(
    process.execPath,
    [
      path.join(appRoot, 'scripts', 'tauri-cli.mjs'),
      'build',
      '--config',
      'src-tauri/tauri.pack.conf.json',
      '--bundles',
      bundles.join(','),
    ],
    appRoot,
  )
  await collectArtifacts(hostManifest)
} catch (error) {
  console.error(`[tauri-pack] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
