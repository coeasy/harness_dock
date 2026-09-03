#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import {
  assertBundledRuntimeIntegrity,
  repairKnownRuntimeAssets,
  requiredNativePackages,
} from './integrity.ts'
import {
  resolvePackedRuntimeClosure,
  type PackedPackageMeta,
} from './packed-closure.ts'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Bump whenever the on-disk runtime composition/selection rules change. This
// prevents an Actions restore-key or a local cache from bypassing new runtime
// builder logic merely because the pinned dsh version stayed the same.
const RUNTIME_LAYOUT_VERSION = 4

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
const packedRuntimeDir = process.env.DSH_PACKED_RUNTIME_DIR
const dest = runtimeDir
  ? path.resolve(repoRoot, runtimeDir as string)
  : runtimeCacheDir(repoRoot)

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
let existingRuntimeLayoutVersion: number | null = null
if (existingLayout) {
  try {
    const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8')) as {
      runtimeLayoutVersion?: unknown
    }
    if (Number.isInteger(manifest.runtimeLayoutVersion)) {
      existingRuntimeLayoutVersion = Number(manifest.runtimeLayoutVersion)
    }
  } catch {
    existingRuntimeLayoutVersion = null
  }
}

async function installTargetNativePackages(): Promise<void> {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packages = requiredNativePackages(platform, arch)
  console.log(`repairing target-native runtime packages: ${packages.join(', ')}`)
  await execFileAsync(
    npmBin,
    [
      'install',
      '--no-save',
      '--force',
      '--omit=dev',
      '--include=optional',
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
      `--os=${platform}`,
      `--cpu=${arch}`,
      ...(platform === 'linux' ? ['--libc=glibc'] : []),
      ...packages,
    ],
    {
      cwd: dest,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
      },
      shell: process.platform === 'win32',
    },
  )
}

async function packedTarballMetadata(tarball: string): Promise<PackedPackageMeta> {
  const { stdout } = await execFileAsync('tar', ['-xOzf', tarball, 'package/package.json'], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  const pkg = JSON.parse(stdout) as PackedPackageMeta
  if (!pkg.name || !pkg.version) throw new Error(`packed tarball has no package identity: ${tarball}`)
  return pkg
}

async function installPackedRuntime(root: string): Promise<void> {
  const absolute = path.resolve(repoRoot, root)
  const entries = (await readdir(absolute, { recursive: true }))
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.tgz')) as string[]
  if (entries.length === 0) throw new Error(`no upstream packed tarballs under ${absolute}`)

  const packed = new Map<string, { tarball: string; meta: PackedPackageMeta }>()
  for (const entry of entries.sort()) {
    const tarball = path.join(absolute, entry)
    const meta = await packedTarballMetadata(tarball)
    if (packed.has(meta.name)) throw new Error(`duplicate packed package ${meta.name}`)
    packed.set(meta.name, { tarball, meta })
  }

  const selectedNames = resolvePackedRuntimeClosure(
    new Map([...packed].map(([name, entry]) => [name, entry.meta])),
  )
  const dependencies: Record<string, string> = {}
  for (const name of selectedNames) {
    const selected = packed.get(name)
    if (!selected) throw new Error(`selected packed package disappeared: ${name}`)
    dependencies[name] = pathToFileURL(selected.tarball).href
  }

  await writeFile(
    path.join(dest, 'package.json'),
    `${JSON.stringify({
      name: 'harnessdock-bundled-runtime',
      private: true,
      version: '0.0.0',
      dependencies,
    }, null, 2)}\n`,
    'utf8',
  )

  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log(
    `installing ${selectedNames.length}/${entries.length} required official packed upstream tarballs for dsh ${origin.dshVersion}`,
  )
  // Match upstream's clean packed-install verification: optional platform
  // packages must not be required for the CLI to start. HarnessDock installs
  // only the target-native optional packages it actually needs immediately
  // afterwards via installTargetNativePackages(), avoiding unrelated release
  // packages and cross-feature optional dependency payloads in shipped runtimes.
  await execFileAsync(
    npmBin,
    [
      'install',
      '--omit=dev',
      '--omit=optional',
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
      '--package-lock=false',
      `--os=${platform}`,
      `--cpu=${arch}`,
      ...(platform === 'linux' ? ['--libc=glibc'] : []),
      '--fetch-timeout=60000',
      '--fetch-retries=3',
    ],
    {
      cwd: dest,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
      },
      shell: process.platform === 'win32',
      maxBuffer: 16 * 1024 * 1024,
    },
  )

  const installedPkg = JSON.parse(
    await readFile(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
  ) as { version?: string }
  if (installedPkg.version !== origin.dshVersion) {
    throw new Error(`packed @deepseek-ai/dsh version ${installedPkg.version ?? 'unknown'} != pinned ${origin.dshVersion}`)
  }
}

if (
  !values.force &&
  existingLayout &&
  existingVersion === origin.dshVersion &&
  existingRuntimeLayoutVersion === RUNTIME_LAYOUT_VERSION
) {
  const repairedAssets = await repairKnownRuntimeAssets(dest)
  try {
    await assertBundledRuntimeIntegrity(dest, platform, arch)
  } catch (error) {
    console.warn(
      `cached runtime needs a native-package repair: ${error instanceof Error ? error.message : String(error)}`,
    )
    await installTargetNativePackages()
    await assertBundledRuntimeIntegrity(dest, platform, arch)
  }
  if (repairedAssets.length > 0) {
    console.log(`repaired known upstream runtime assets: ${repairedAssets.join(', ')}`)
  }
  console.log(`bundled runtime already present and matches dsh ${origin.dshVersion}: ${dest}`)
  process.exit(0)
}
if (!values.force && existingLayout) {
  if (existingVersion !== origin.dshVersion) {
    console.log(
      `bundled runtime version mismatch at ${dest}: found ${existingVersion ?? 'unknown'}, expected ${origin.dshVersion}; rebuilding`,
    )
  } else {
    console.log(
      `bundled runtime layout mismatch at ${dest}: found ${existingRuntimeLayoutVersion ?? 'legacy'}, expected ${RUNTIME_LAYOUT_VERSION}; rebuilding`,
    )
  }
}

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

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
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
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
        await execFileAsync('unzip', ['-q', tmp, '-d', dest], { windowsHide: true })
      }
      for (const entry of await readdir(extractedRoot)) {
        await rename(path.join(extractedRoot, entry), path.join(dest, entry))
      }
      await rm(extractedRoot, { recursive: true, force: true })
      await rm(tmp, { force: true })
    } else {
      await execFileAsync('tar', ['-xf', tmp, '-C', dest, '--strip-components=1'], { windowsHide: true })
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

if (packedRuntimeDir) {
  await installPackedRuntime(packedRuntimeDir)
} else {
  if (!origin.npmTarball) {
    throw new Error(
      `dsh ${origin.dshVersion} is not published to npm; set DSH_PACKED_RUNTIME_DIR to the official packed tarballs`,
    )
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
          '--include=optional',
          '--no-fund',
          '--no-audit',
          `--os=${platform}`,
          `--cpu=${arch}`,
          ...(platform === 'linux' ? ['--libc=glibc'] : []),
          '--fetch-timeout=60000',
          '--fetch-retries=3',
          '--fetch-retry-mintimeout=1000',
          '--fetch-retry-maxtimeout=10000',
          `--registry=${registry}`,
          `@deepseek-ai/dsh@${origin.dshVersion}`,
        ],
        {
          cwd: dest,
          windowsHide: true,
          env: {
            ...process.env,
            NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
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
  if (!installed) throw lastNpmError ?? new Error('all npm registries failed')
}

await installTargetNativePackages()

if (!inspectBundledRuntime(dest, platform)) {
  throw new Error(`prepare-runtime finished but layout is incomplete under ${dest}`)
}

const repairedAssets = await repairKnownRuntimeAssets(dest)
if (repairedAssets.length > 0) {
  console.log(`repaired known upstream runtime assets: ${repairedAssets.join(', ')}`)
}

const { removedBytes: prunedBytes, removedCount: prunedCount } = await pruneBundledRuntime(
  dest,
  platform,
  arch,
)
await assertBundledRuntimeIntegrity(dest, platform, arch)

await writeFile(
  path.join(dest, 'manifest.json'),
  `${JSON.stringify(
    {
      dshVersion: origin.dshVersion,
      gitTag: origin.gitTag,
      gitCommit: origin.gitCommit,
      runtimeSource: packedRuntimeDir ? 'official-source-pack' : 'npm',
      runtimeLayoutVersion: RUNTIME_LAYOUT_VERSION,
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
