#!/usr/bin/env node
/**
 * Deduplicated desktop pack entry point. Replaces the eight pack:* script
 * chains in apps/desktop/package.json with a single script:
 *
 *   node scripts/pack.mjs --os <current|win|mac|linux> --scenario <thin|full>
 *
 * Steps (matching the previous pack:* chains exactly):
 *   1. Bundle the embedded client and independent shell plugin so their lib
 *      files are always current.
 *   2. Bundle the Electron main/preload (pnpm bundle, at apps/desktop).
 *   3. Run electron-builder with the scenario config and OS targets.
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
  console.log(`Usage: node scripts/pack.mjs [--os current|win|mac|linux] [--scenario thin|full]

  --os        target OS for electron-builder (default: current)
  --scenario  thin or full package (default: thin)
  --arch      macOS architecture: all, x64, or arm64 (default: all)

  os targets:
    current  no target args, uses electron-builder.yml / electron-builder.full.yml
    win      --win nsis portable zip --x64
    mac      --mac dmg zip --x64 --arm64
    linux    --linux AppImage deb --x64
`)
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

// Auto-update feed (Phase A): bake app-update.yml only when a GitHub upstream
// is configured at build time. electron-builder throws on undefined ${env.*}
// macros, so we inject via CLI overrides instead of the yml. DSH_PACK_OUTPUT
// additionally overrides the electron-builder output directory (handy when the
// default release/<scenario> dir is locked by Windows/AV, or for temp builds).
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

// Windows packaging spends most of its time compressing the full runtime tree.
// Normal compression substantially reduces release build time while keeping
// the installers fully functional; the trade-off is a modestly larger package.
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
    // Avoid walking vendored dependency trees; the app resource directory is
    // always above them in electron-builder's unpacked output.
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
  const shellDirs = resourceDirs.filter((dir) =>
    existsSync(path.join(dir, 'plugin-harness-shell', 'index.js')),
  )
  if (shellDirs.length === 0) {
    throw new Error(
      `[pack] packaged Harness Shell plugin missing under ${outputRoot}; refusing to publish a client without the v0.2.0 shell`,
    )
  }
  const compatibilityDirs = resourceDirs.filter((dir) =>
    existsSync(path.join(dir, 'dsh-client-runtime-compat', 'index.js')) &&
    existsSync(path.join(dir, 'dsh-client-runtime-compat', 'client.js')),
  )
  if (compatibilityDirs.length === 0) {
    throw new Error(
      `[pack] packaged client-runtime compatibility layer missing under ${outputRoot}; refusing to publish a plugin-drift-prone package`,
    )
  }
  if (scenario === 'full') {
    const runtimeDirs = resourceDirs.filter(
      (dir) =>
        existsSync(path.join(dir, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) &&
        existsSync(path.join(dir, 'dsh-runtime', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'))),
    )
    if (runtimeDirs.length === 0) {
      throw new Error(
        `[pack] packaged full runtime missing under ${outputRoot}; refusing to publish a package that downloads ~300 MB on first launch`,
      )
    }
    console.log(`[pack] verified full runtime + embedded/shell plugins in ${runtimeDirs.length} unpacked app(s)`)
  } else {
    console.log(`[pack] verified embedded/shell plugins in ${pluginDirs.length} unpacked app(s)`)
  }
}

async function prepareFullRuntimes() {
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
  // 1. keep the embedded client bundle current
  await run('pnpm', ['--filter', '@dsh/plugin-embedded-client', 'bundle'], repoRoot)
  await run('pnpm', ['--filter', '@dsh/plugin-harness-shell', 'bundle'], repoRoot)
  // 2. bundle the Electron main/preload
  await run('pnpm', ['bundle'], desktopRoot)
  // Full builds need a matching bundled runtime for every target architecture.
  // CI can set DSH_SKIP_RUNTIME_PREPARE after downloading prepared runtime artifacts.
  if (scenario === 'full' && process.env.DSH_SKIP_RUNTIME_PREPARE !== '1') {
    await prepareFullRuntimes()
  }
  // 3. electron-builder with scenario config + OS targets
  await run(
    'pnpm',
    ['exec', 'electron-builder', ...targetsFor(os, arch), '--config', config, '--publish', 'never', ...extraArgs],
    desktopRoot,
  )
  verifyPackagedResources()
  console.log(`[pack] done: os=${os} scenario=${scenario}`)
} catch (error) {
  console.error(`[pack] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
