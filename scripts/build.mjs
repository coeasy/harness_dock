#!/usr/bin/env node
/**
 * One-click desktop client build script.
 *
 * Usage:
 *   node scripts/build.mjs                                  # current OS, thin
 *   node scripts/build.mjs --os win --scenario both         # Windows thin + full
 *   node scripts/build.mjs --os mac --scenario full         # macOS full (bundled runtime)
 *   node scripts/build.mjs --os all --scenario both         # everything this host can build
 *   node scripts/build.mjs --skip-install --skip-tests      # fast rebuild
 *
 * Scenarios:
 *   thin — small download, fetches the pinned dsh runtime via npx on first run.
 *   full — bundles node.exe + dsh runtime into the package, works offline.
 *
 * Every Windows build produces a Portable single-file exe (standalone,
 * no installation required) alongside the NSIS installer and zip.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// thin 和 full 分别输出到 release/thin 与 release/full，避免
// electron-builder 清空共享目录时把另一种场景的产物破坏掉。
const releaseRoots = [
  path.join(repoRoot, 'apps', 'desktop', 'release', 'full'),
  path.join(repoRoot, 'apps', 'desktop', 'release', 'thin'),
]

const { values } = parseArgs({
  options: {
    os: { type: 'string', short: 'o' },
    scenario: { type: 'string', short: 's' },
    'skip-install': { type: 'boolean' },
    'skip-tests': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/build.mjs [options]

Options:
  -o, --os <os>         win | mac | linux | all | current (default: current)
  -s, --scenario <s>    thin | full | both (default: thin)
      --skip-install    skip pnpm install
      --skip-tests      skip unit tests
  -h, --help            show this help

Platform rules (match GitHub release runners):
  win    — buildable on Windows hosts (NSIS + portable exe + zip)
  mac    — only on macOS hosts (dmg + zip, x64 & arm64)
  linux  — only on Linux hosts (AppImage + deb)
`)
  process.exit(0)
}

const hostPlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'

const osArg = values.os ?? 'current'
const scenarioArg = values.scenario ?? 'thin'

const OS_KEYS = ['win', 'mac', 'linux']
const SCENARIOS = ['thin', 'full']

if (!['all', 'current', ...OS_KEYS].includes(osArg)) {
  fail(`Unknown --os "${osArg}". Valid: ${['all', 'current', ...OS_KEYS].join(' | ')}`)
}
if (![...SCENARIOS, 'both'].includes(scenarioArg)) {
  fail(`Unknown --scenario "${scenarioArg}". Valid: ${[...SCENARIOS, 'both'].join(' | ')}`)
}

const osList = osArg === 'all' ? OS_KEYS : osArg === 'current' ? [hostPlatform] : [osArg]
const scenarios = scenarioArg === 'both' ? SCENARIOS : [scenarioArg]

// Cross-OS build matrix: only win artifacts build off-host reliably (NSIS/portable/zip).
const nativeOnly = { mac: 'macOS', linux: 'Linux' }
for (const os of osList) {
  if (nativeOnly[os] && os !== hostPlatform) {
    fail(`--os ${os} must run on a ${nativeOnly[os]} host (current host: ${hostPlatform}). Use GitHub Actions release workflow for cross-OS builds.`)
  }
}

console.log(`\n=== DeepSeek Harness desktop build ===`)
console.log(`host: ${hostPlatform} | os: ${osList.join(', ')} | scenario: ${scenarios.join(', ')}\n`)

function run(command, args, label) {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status}`)
  }
}

function fail(message) {
  console.error(`\n[build] ERROR: ${message}`)
  process.exit(1)
}

function pnpm(args, label) {
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, label)
}

// Friendly early failure when invoked directly without pnpm on PATH
// (build.bat / build.sh normally guarantee pnpm via bootstrap.mjs).
const pnpmCheck = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  encoding: 'utf8',
})
if (pnpmCheck.status !== 0) {
  fail(
    'pnpm not found on PATH. Either run via scripts/build.bat (Windows) or '
    + 'scripts/build.sh (macOS/Linux), which provision pnpm automatically, '
    + 'or manually install pnpm 10 first: corepack enable && corepack prepare pnpm@10.12.0 --activate',
  )
}

if (!values['skip-install']) {
  pnpm(['install', '--frozen-lockfile'], 'pnpm install')
}

if (!values['skip-tests']) {
  pnpm(['test'], 'unit tests')
}

const jobs = []
for (const os of osList) {
  for (const scenario of scenarios) {
    const script = scenario === 'full' ? `pack:desktop:${os}:full` : `pack:desktop:${os}`
    jobs.push({ os, scenario, script })
  }
}

for (const job of jobs) {
  pnpm([job.script], `pack ${job.os} (${job.scenario})`)
}

// Best-effort size-budget gate (scheme D4): after all pack jobs, run
// `pnpm check:size` against the produced artifacts. The gate never blocks the
// build — a non-zero exit (missing artifacts or a budget overrun) only warns.
if (jobs.length > 0) {
  console.log(`\n> size budget gate (best-effort)`)
  const checkSize = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['check:size'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (checkSize.status !== 0) {
    console.warn(
      `\n[build] WARN: pnpm check:size exited with code ${checkSize.status} — ` +
        `size budget gate is best-effort and does not block the build.`,
    )
  }
}

// Summarize artifacts produced by this run.
console.log(`\n=== Artifacts ===`)
const artifactExt = /\.(exe|dmg|zip|AppImage|deb|blockmap|snap)$/i
let found = 0
for (const releaseDir of releaseRoots) {
  if (!existsSync(releaseDir)) continue
  const files = readdirSync(releaseDir)
    .map((name) => {
      const full = path.join(releaseDir, name)
      return { name, size: statSync(full).isFile() ? statSync(full).size : 0 }
    })
    .filter((f) => artifactExt.test(f.name))
    .sort((a, b) => b.size - a.size)
  for (const f of files) {
    found += 1
    console.log(`  ${path.relative(path.dirname(releaseDir), path.join(releaseDir, f.name))}  (${(f.size / 1024 / 1024).toFixed(1)} MB)`)
  }
}
if (found === 0) console.log('  (none found)')

console.log(`\n[build] done: ${jobs.map((j) => `${j.os}/${j.scenario}`).join(', ')}`)
