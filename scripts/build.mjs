#!/usr/bin/env node
/**
 * One-click Tauri client build.
 *
 * The desktop product has one native host: apps/tauri. Runtime preparation is
 * intentionally separate because release CI supplies the pinned full runtime
 * for each target platform before invoking `cargo tauri build`.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const { values } = parseArgs({
  options: {
    'skip-install': { type: 'boolean' },
    'skip-tests': { type: 'boolean' },
    'check-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(`Usage: node scripts/build.mjs [options]

Options:
      --skip-install    skip pnpm install
      --skip-tests      skip unit tests
      --check-only      bundle the sidecar and run cargo check only
  -h, --help            show this help

The Tauri host is the only desktop build target. Cross-platform release
artifacts are produced by .github/workflows/tauri-candidate.yml.`)
  process.exit(0)
}

function fail(message) {
  console.error(`\n[build] ERROR: ${message}`)
  process.exit(1)
}

function run(command, args, label) {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`)
}

const pnpmVersion = spawnSync(pnpmCommand, ['--version'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  encoding: 'utf8',
})
if (pnpmVersion.status !== 0) {
  fail('pnpm not found on PATH; run scripts/bootstrap.mjs or install pnpm 10 first')
}

if (!values['skip-install']) {
  run(pnpmCommand, ['install', '--frozen-lockfile', '--prefer-offline'], 'pnpm install')
}
if (!values['skip-tests']) run(pnpmCommand, ['test'], 'unit tests')

run(pnpmCommand, ['--filter', '@dsh/plugin-embedded-client', 'build'], 'build embedded client plugin')
run(pnpmCommand, ['--filter', '@dsh/plugin-harness-shell', 'build'], 'build independent Harness Shell plugin')
run(pnpmCommand, ['--filter', '@dsh/tauri', 'bundle:sidecar'], 'bundle Gateway sidecar')
run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:check'], 'check Tauri Rust host')
if (!values['check-only']) run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:build'], 'build Tauri client')

console.log('\n[build] Tauri build completed.')
