#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ORIGIN_PATH, readOriginFile } from '@dsh/docs-sync'
import {
  bundledNodeRel,
  bundledRuntimeVersion,
  canCopyHostNode,
  inspectBundledRuntime,
  NODE_BUNDLE_VERSION,
  NODE_DIST_MIRRORS,
  nodeOfficialUrl,
  runtimeCacheDir,
} from './bundled.ts'
import { pruneBundledRuntime } from './prune.ts'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    'prune-only': { type: 'boolean', default: false },
    platform: { type: 'string' },
    arch: { type: 'string' },
    'runtime-dir': { type: 'string' },
  },
})

const platform = (values.platform ?? process.env.DSH_RUNTIME_PLATFORM ?? process.platform) as NodeJS.Platform
const arch = values.arch ?? process.env.DSH_RUNTIME_ARCH ?? process.arch
const runtimeDir = values['runtime-dir'] ?? process.env.DSH_RUNTIME_DIR
const dest = runtimeDir
  ? path.resolve(repoRoot, runtimeDir as string)
  : runtimeCacheDir(repoRoot)

// --prune-only: apply the size pruning to an existing bundled runtime without
// re-downloading node or re-running npm install. Useful after the prune rules
// change or to shrink a runtime prepared before this feature existed.
if (values['prune-only']) {
  if (!inspectBundledRuntime(dest, platform)) {
    throw new Error(`--prune-only requires an existing bundled runtime under ${dest}`)
  }
  const { removedBytes } = await pruneBundledRuntime(dest, platform, arch)
  try {
    const manifestRaw = await readFile(path.join(dest, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>
    manifest.prunedBytes = (Number(manifest.prunedBytes) || 0) + removedBytes
    manifest.prunedAt = new Date().toISOString()
    await writeFile(path.join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch {
    // no manifest to update
  }
  console.log(`[prune-only] done: ${dest} (${(removedBytes / 1024 / 1024).toFixed(1)} MB removed)`)
  process.exit(0)
}

const origin = await readOriginFile(ORIGIN_PATH)
const existingLayout = inspectBundledRuntime(dest, platform)
const existingVersion = existingLayout ? bundledRuntimeVersion(dest) : null
if (!values.force && existingLayout && existingVersion === origin.dshVersion) {
  console.log(`bundled runtime already present and matches dsh ${origin.dshVersion}: ${dest}`)
  process.exit(0)
}
if (!values.force && existingLayout) {
  console.log(
    `bundled runtime version mismatch at ${dest}: found ${existingVersion ?? 'unknown'}, expected ${origin.dshVersion}; rebuilding`,
  )
}

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

// npm scopes an install to the nearest package.json; without one it walks up to
// the workspace root and mixes the repo's devDependencies into peer resolution
// (ERESOLVE conflicts, e.g. typescript-eslint vs rollup). Pin a minimal local
// package.json so the bundled runtime installs in isolation.
await writeFile(
  path.join(dest, 'package.json'),
  `${JSON.stringify({ name: 'harnessdock-bundled-runtime', private: true, version: '0.0.0' }, null, 2)}\n`,
  'utf8',
)

const extraMirror = process.env.NODE_MIRROR
const mirrors = extraMirror ? [extraMirror, ...NODE_DIST_MIRRORS] : [...NODE_DIST_MIRRORS]
let nodeSource = ''
let lastError: unknown

for (const mirror of mirrors) {
  const dist = nodeOfficialUrl(NODE_BUNDLE_VERSION, platform, arch, mirror)
  try {
    console.log(`downloading ${dist.url}`)
    const response = await fetch(dist.url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`)
    }
    const tmp = path.join(dest, path.basename(new URL(dist.url).pathname))
    await pipeline(response.body, createWriteStream(tmp))
    if (dist.kind === 'file') {
      await copyFile(tmp, path.join(dest, dist.nodeRel))
      await rm(tmp, { force: true })
    } else if (dist.kind === 'zip') {
      const extractedRoot = path.join(dest, path.basename(tmp, '.zip'))
      if (process.platform === 'win32') {
        const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`
        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath ${quotePowerShell(tmp)} -DestinationPath ${quotePowerShell(dest)} -Force`,
          ],
          { windowsHide: true },
        )
      } else {
        await execFileAsync('unzip', ['-q', tmp, '-d', dest], {
          windowsHide: true,
        })
      }
      for (const entry of await readdir(extractedRoot)) {
        await rename(path.join(extractedRoot, entry), path.join(dest, entry))
      }
      await rm(extractedRoot, { recursive: true, force: true })
      await rm(tmp, { force: true })
    } else {
      await execFileAsync('tar', ['-xf', tmp, '-C', dest, '--strip-components=1'], {
        windowsHide: true,
      })
      await rm(tmp, { force: true })
    }
    nodeSource = dist.url
    lastError = undefined
    break
  } catch (error) {
    lastError = error
    console.warn(`mirror failed: ${dist.url}`)
  }
}

if (!nodeSource) {
  if (
    canCopyHostNode({
      hostPlatform: process.platform,
      targetPlatform: platform,
      electronVersion: process.versions.electron,
    })
  ) {
    const target = path.join(dest, bundledNodeRel(platform))
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(process.execPath, target)
    nodeSource = `host:${process.execPath}`
    console.log(`using host node ${process.version} -> ${target}`)
  } else if (lastError) {
    throw lastError
  } else {
    throw new Error('could not vendor a Node binary')
  }
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const registries = [
  ...(process.env.DSH_NPM_MIRROR ? [process.env.DSH_NPM_MIRROR] : []),
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]
let installed = false
let lastNpmError
for (const registry of registries) {
  console.log(`npm install @deepseek-ai/dsh@${origin.dshVersion} --registry ${registry}`)
  try {
    await execFileAsync(
      npmBin,
      [
        'install',
        '--omit=dev',
        '--no-fund',
        '--no-audit',
        `--fetch-timeout=60000`,
        `--fetch-retries=3`,
        `--fetch-retry-mintimeout=1000`,
        `--fetch-retry-maxtimeout=10000`,
        `--registry=${registry}`,
        `@deepseek-ai/dsh@${origin.dshVersion}`,
      ],
      {
        cwd: dest,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS:
            process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
        },
        shell: process.platform === 'win32',
      },
    )
    installed = true
    break
  } catch (error) {
    lastNpmError = error
    console.warn(`registry failed: ${registry}`)
  }
}
if (!installed) {
  throw lastNpmError ?? new Error('all npm registries failed')
}

if (!inspectBundledRuntime(dest, platform)) {
  throw new Error(`prepare-runtime finished but layout is incomplete under ${dest}`)
}

// Size pruning: the bundled runtime only ever runs on this host, so drop
// @img/sharp variants for other platforms, non-host node-pty prebuilds, and
// dev/debug weight (.map / .pdb / .d.ts) — dead bytes in the full package.
const { removedBytes: prunedBytes, removedCount: prunedCount } = await pruneBundledRuntime(
  dest,
  platform,
  arch,
)

await writeFile(
  path.join(dest, 'manifest.json'),
  `${JSON.stringify(
    {
      dshVersion: origin.dshVersion,
      nodeVersion: NODE_BUNDLE_VERSION,
      nodeSource,
      platform,
      arch,
      prunedCount,
      prunedBytes,
      preparedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`bundled runtime ready: ${dest}`)
