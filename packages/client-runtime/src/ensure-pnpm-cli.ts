#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectBundledRuntime, runtimeCacheDir } from './bundled.ts'
import {
  assertBundledPnpm,
  bundledPnpmEntry,
  bundledPnpmPackageDir,
  PNPM_BUNDLE_VERSION,
  writeBundledPnpmShim,
} from './pnpm-tool.ts'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    arch: { type: 'string' },
    'runtime-dir': { type: 'string' },
  },
})

const platform = (values.platform ?? process.env.DSH_RUNTIME_PLATFORM ?? process.platform) as NodeJS.Platform
const arch = values.arch ?? process.env.DSH_RUNTIME_ARCH ?? process.arch
const runtimeDir = values['runtime-dir'] ?? process.env.DSH_RUNTIME_DIR
const dest = runtimeDir ? path.resolve(repoRoot, runtimeDir) : runtimeCacheDir(repoRoot)

if (!inspectBundledRuntime(dest, platform)) {
  throw new Error(`cannot embed pnpm: bundled Node+dsh runtime is incomplete under ${dest}`)
}

let ready = false
try {
  await assertBundledPnpm(dest, platform)
  ready = true
} catch {
  ready = false
}

if (!ready) {
  const toolRoot = path.join(dest, 'tools', 'pnpm')
  await mkdir(toolRoot, { recursive: true })
  await writeFile(
    path.join(toolRoot, 'package.json'),
    `${JSON.stringify({
      name: 'harnessdock-bundled-pnpm',
      private: true,
      version: '0.0.0',
      dependencies: { pnpm: PNPM_BUNDLE_VERSION },
    }, null, 2)}\n`,
    'utf8',
  )

  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log(`embedding pnpm ${PNPM_BUNDLE_VERSION} for dsh plugin management`)
  await execFileAsync(
    npmBin,
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
      '--package-lock=false',
      `--os=${platform}`,
      `--cpu=${arch}`,
    ],
    {
      cwd: toolRoot,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
      },
      shell: process.platform === 'win32',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  await writeBundledPnpmShim(dest, platform)
}

await assertBundledPnpm(dest, platform)
const { stdout } = await execFileAsync(process.execPath, [bundledPnpmEntry(dest), '--version'], {
  cwd: bundledPnpmPackageDir(dest),
  windowsHide: true,
})
if (stdout.trim() !== PNPM_BUNDLE_VERSION) {
  throw new Error(`bundled pnpm smoke returned ${stdout.trim() || 'empty'}, expected ${PNPM_BUNDLE_VERSION}`)
}

const manifestPath = path.join(dest, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
manifest.pnpmEmbedded = true
manifest.pnpmVersion = PNPM_BUNDLE_VERSION
manifest.pluginManagementReady = true
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`[pnpm-runtime] bundled pnpm ${PNPM_BUNDLE_VERSION} ready for ${platform}/${arch}`)
