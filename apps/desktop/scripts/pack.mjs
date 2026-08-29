#!/usr/bin/env node
/**
 * Desktop pack entry point.
 *
 * Both scenarios use the same exact prepared dsh module tree:
 *   thin: modules only, executed by Electron's Node
 *   full: modules + dedicated Node 22.19 runtime
 */
import { readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(desktopRoot, '../..')

const OS_VALUES = ['current', 'win', 'mac', 'linux']
const SCENARIO_VALUES = ['thin', 'full']
const ARCH_VALUES = ['all', 'x64', 'arm64']

const { values } = parseArgs({
  options: {
    os: { type: 'string', default: 'current' },
    scenario: { type: 'string', default: 'thin' },
    arch: { type: 'string', default: 'all' },
    help: { type: 'boolean', default: false },
  },
})

function usage() {
  console.log(`Usage: node scripts/pack.mjs [--os current|win|mac|linux] [--scenario thin|full]\n\n  --os        target OS for electron-builder (default: current)\n  --scenario  thin or full package (default: thin)\n  --arch      macOS architecture: all, x64, or arm64 (default: all)\n\n  os targets:\n    current  no target args, uses electron-builder.yml / electron-builder.full.yml\n    win      --win nsis portable zip --x64\n    mac      --mac dmg zip --x64 --arm64\n    linux    --linux AppImage deb --x64\n`)
}

if (values.help) {
  usage()
  process.exit(0)
}

const os = values.os
const scenario = values.scenario
const arch = values.arch
if (!OS_VALUES.includes(os)) {
  console.error(`[pack] unknown --os "${os}" (expected one of: ${OS_VALUES.join(', ')})`)
  usage()
  process.exit(1)
}
if (!SCENARIO_VALUES.includes(scenario)) {
  console.error(`[pack] unknown --scenario "${scenario}" (expected one of: ${SCENARIO_VALUES.join(', ')})`)
  usage()
  process.exit(1)
}
if (!ARCH_VALUES.includes(arch)) {
  console.error(`[pack] unknown --arch "${arch}" (expected one of: ${ARCH_VALUES.join(', ')})`)
  usage()
  process.exit(1)
}

function targetsFor(targetOs, targetArch) {
  if (targetOs === 'mac') {
    if (targetArch === 'x64') return ['--mac', 'dmg', 'zip', '--x64']
    if (targetArch === 'arm64') return ['--mac', 'dmg', 'zip', '--arm64']
    return ['--mac', 'dmg', 'zip', '--x64', '--arm64']
  }
  return {
    current: [],
    win: ['--win', 'nsis', 'portable', 'zip', '--x64'],
    linux: ['--linux', 'AppImage', 'deb', '--x64'],
  }[targetOs]
}
const config = scenario === 'full' ? 'electron-builder.full.yml' : 'electron-builder.yml'

const extraArgs = []
const owner = process.env.GH_OWNER
const repo = process.env.GH_REPO
if (owner && repo) {
  extraArgs.push(
    '-c.publish.provider=github',
    `-c.publish.owner=${owner}`,
    `-c.publish.repo=${repo}`,
  )
  console.log(`[pack] baking update feed for github.com/${owner}/${repo}`)
} else {
  console.log('[pack] GH_OWNER/GH_REPO not set — no update feed baked; auto-update stays inert')
}
if (process.env.DSH_PACK_OUTPUT) {
  extraArgs.push(`-c.directories.output=${process.env.DSH_PACK_OUTPUT}`)
  console.log(`[pack] output overridden to ${process.env.DSH_PACK_OUTPUT}`)
}

if (os === 'win') {
  extraArgs.push('-c.compression=normal')
  console.log('[pack] Windows compression=normal')
}

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[pack] ${command} ${args.join(' ')} (cwd: ${cwd})`)
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      shell: process.platform === 'win32',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

function findResourceDirs(root, depth = 0, result = []) {
  if (depth > 10 || !existsSync(root)) return result
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const fullPath = path.join(root, entry.name)
    if (entry.name.toLowerCase() === 'resources') {
      result.push(fullPath)
      continue
    }
    if (entry.name === 'node_modules') continue
    findResourceDirs(fullPath, depth + 1, result)
  }
  return result
}

function verifyPackagedResources() {
  const outputRoot = path.resolve(
    desktopRoot,
    process.env.DSH_PACK_OUTPUT || path.join('release', scenario),
  )
  const resourceDirs = findResourceDirs(outputRoot)
  const pluginDirs = resourceDirs.filter((dir) =>
    existsSync(path.join(dir, 'plugin-embedded-client', 'index.js')),
  )
  if (pluginDirs.length === 0) {
    throw new Error(
      `[pack] packaged embedded-client plugin missing under ${outputRoot}; refusing to publish a broken client`,
    )
  }

  const runtimeDirs = resourceDirs.filter((dir) =>
    existsSync(path.join(dir, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
  )
  if (runtimeDirs.length === 0) {
    throw new Error(
      `[pack] packaged ${scenario} dsh modules missing under ${outputRoot}; refusing to publish a client that cannot run the pinned Git-only release`,
    )
  }

  if (scenario === 'full') {
    const withNode = runtimeDirs.filter((dir) =>
      existsSync(path.join(dir, 'dsh-runtime', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'))),
    )
    if (withNode.length === 0) {
      throw new Error(`[pack] packaged full runtime has no dedicated Node under ${outputRoot}`)
    }
    console.log(`[pack] verified full runtime + embedded plugin in ${withNode.length} unpacked app(s)`)
  } else {
    console.log(`[pack] verified thin module seed + embedded plugin in ${runtimeDirs.length} unpacked app(s)`)
  }
}

async function prepareRuntimes() {
  const runtimePlatform = { win: 'win32', mac: 'darwin', linux: 'linux' }[os] ?? process.platform
  const arches = os === 'mac'
    ? (arch === 'all' ? ['x64', 'arm64'] : [arch])
    : [arch === 'all' ? process.arch : arch]

  for (const targetArch of arches) {
    const runtimeDir = os === 'mac' ? path.join('runtimes', 'pack-' + targetArch) : path.join('runtimes', 'pack')
    await run(
      'pnpm',
      ['--filter', '@dsh/client-runtime', 'bundle-runtime'],
      repoRoot,
      {
        DSH_RUNTIME_PLATFORM: runtimePlatform,
        DSH_RUNTIME_ARCH: targetArch,
        DSH_RUNTIME_DIR: runtimeDir,
      },
    )
  }
}

try {
  await run('pnpm', ['--filter', '@dsh/plugin-embedded-client', 'bundle'], repoRoot)
  await run('pnpm', ['bundle'], desktopRoot)
  // CI can set DSH_SKIP_RUNTIME_PREPARE after downloading exact prepared
  // runtime artifacts. Local builds prepare the runtime for either scenario.
  if (process.env.DSH_SKIP_RUNTIME_PREPARE !== '1') {
    await prepareRuntimes()
  }
  await run(
    'pnpm',
    ['exec', 'electron-builder', ...targetsFor(os, arch), '--config', config, '--publish', 'never', ...extraArgs],
    desktopRoot,
    { DSH_PACKAGE_SCENARIO: scenario },
  )
  verifyPackagedResources()
  console.log(`[pack] done: os=${os} scenario=${scenario}`)
} catch (error) {
  console.error(`[pack] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
