import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  downloadTarball,
  NPM_REGISTRIES,
  resolveTarballCandidates,
  withTimeout,
} from './npm-mirrors.ts'
import { pruneBundledRuntime } from './prune.ts'
import { assertBundledRuntimeIntegrity, repairKnownRuntimeAssets } from './integrity.ts'
import type { RuntimeProgressEvent } from './runtime.ts'

const execFileAsync = promisify(execFile)

interface PackageMeta {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  os?: string[]
  cpu?: string[]
  dist?: { tarball?: string; integrity?: string }
}

function matchesPlatformConstraint(values: string[] | undefined, target: string): boolean {
  if (!values || values.length === 0) return true
  const constraints = values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  const normalizedTarget = target.trim().toLowerCase()
  if (constraints.includes(`!${normalizedTarget}`)) return false
  if (constraints.includes('any')) return true
  const positive = constraints.filter((value) => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(normalizedTarget)
}

/**
 * Applies npm package.json `os` / `cpu` constraints before a tarball is added
 * to the runtime download plan. This prevents a Windows thin install from
 * downloading Linux/macOS-only optional native packages (and vice versa).
 */
export function isPackagePlatformCompatible(
  meta: Pick<PackageMeta, 'os' | 'cpu'>,
  platform: string,
  arch: string,
): boolean {
  return matchesPlatformConstraint(meta.os, platform) && matchesPlatformConstraint(meta.cpu, arch)
}

/**
 * Resolves a semantic range server-side via the registry "/<pkg>/<range>"
 * endpoint, avoiding any local semver implementation.
 * Returns null when no registry can serve the package/range.
 */
export async function resolveVersion(
  name: string,
  range: string,
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 30_000,
): Promise<{ meta: PackageMeta; registry: string } | null> {
  const registries = [...(env.DSH_NPM_MIRROR ? [env.DSH_NPM_MIRROR] : []), ...NPM_REGISTRIES]
  // Bare "*" / "latest" resolves to each registry's default view, same as
  // `npm view <pkg>`; concrete ranges are resolved server-side via the
  // "/<pkg>/<range>" endpoint.
  const pathSuffix = range === '*' || range === 'latest' ? 'latest' : encodeURIComponent(range)
  const errors: string[] = []
  for (const registry of registries) {
    try {
      const url = `${registry.replace(/\/$/, '')}/${name}/${pathSuffix}`
      const response = await withTimeout(
        fetch(url, { signal: AbortSignal.timeout(timeoutMs) }),
        timeoutMs,
        `GET ${url}`,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const meta = (await response.json()) as PackageMeta
      if (meta && typeof meta.version === 'string' && meta.dist?.tarball) {
        return { meta, registry }
      }
      throw new Error('unexpected payload shape')
    } catch (error) {
      errors.push(`${registry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.warn(`[fetch-runtime] resolve ${name}@${range} failed:\n  ${errors.join('\n  ')}`)
  return null
}

/** Node_modules directory for a package name, e.g. @deepseek-ai/dsh keeps its scope folder. */
export function moduleDir(nodeModules: string, name: string): string {
  return path.join(nodeModules, ...name.split('/'))
}

/** Marker file written after a package tarball is fully extracted and verified. */
export const INSTALL_MARKER = '.dsh-install-ok'

function isFullyInstalled(dir: string): boolean {
  return existsSync(path.join(dir, INSTALL_MARKER)) && existsSync(path.join(dir, 'package.json'))
}

export interface PlanEntry {
  name: string
  version: string
  meta: PackageMeta
}

/**
 * Resolves the full transitive dependency closure WITHOUT downloading
 * anything, so the exact platform-compatible tarball count is known up front
 * and download progress can be reported as a true percentage.
 *
 * Flat layout rule: first version resolved wins; a conflicting second
 * version fails loudly instead of silently mixing.
 *
 * Resolve runs breadth-first, resolving each level's packages concurrently
 * (capped) so the metadata phase no longer stalls for minutes, and reports
 * progress via `onResolve` as each package is resolved.
 */
const RESOLVE_CONCURRENCY = 8

async function resolveClosure(
  rootSpecs: Array<{ name: string; range: string }>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onResolve?: (done: number) => void,
): Promise<PlanEntry[]> {
  const plannedVersions = new Map<string, string>()
  const processedNames = new Set<string>()
  const plan: PlanEntry[] = []
  const targetPlatform = env.DSH_RUNTIME_PLATFORM?.trim() || process.platform
  const targetArch = env.DSH_RUNTIME_ARCH?.trim() || process.arch
  let frontier = [...rootSpecs]
  let resolvedCount = 0

  while (frontier.length > 0) {
    // dedupe this level by name: first occurrence wins (flat-layout rule)
    const seen = new Set<string>()
    const level = frontier.filter((spec) => {
      if (plannedVersions.has(spec.name) || processedNames.has(spec.name) || seen.has(spec.name)) return false
      seen.add(spec.name)
      processedNames.add(spec.name)
      return true
    })
    if (level.length === 0) break

    const results: Array<{ entry: PlanEntry; deps: Array<{ name: string; range: string }> } | null> = []
    for (let i = 0; i < level.length; i += RESOLVE_CONCURRENCY) {
      const chunk = level.slice(i, i + RESOLVE_CONCURRENCY)
      const chunkResults = await Promise.all(
        chunk.map(async (spec) => {
          const resolved = await resolveVersion(spec.name, spec.range, env, timeoutMs)
          if (!resolved) {
            throw new Error(`cannot resolve ${spec.name}@${spec.range} from any registry`)
          }
          const meta = resolved.meta
          const version = meta.version as string
          if (!version || !meta.dist?.tarball) {
            throw new Error(`registry metadata for ${spec.name} is missing version/tarball`)
          }
          resolvedCount += 1
          onResolve?.(resolvedCount)
          if (!isPackagePlatformCompatible(meta, targetPlatform, targetArch)) {
            console.log(
              `[fetch-runtime] skip ${spec.name}@${version}: incompatible with ${targetPlatform}/${targetArch}`,
            )
            return null
          }
          plannedVersions.set(spec.name, version)
          // npm 7+ auto-installs peerDependencies alongside dependencies;
          // optionalDependencies are part of the runtime closure too, but the
          // package itself is filtered by npm os/cpu constraints before any
          // of its tarball or descendants enter the platform download plan.
          const deps: Array<{ name: string; range: string }> = []
          const specMaps = [meta.dependencies, meta.optionalDependencies, meta.peerDependencies]
          for (const specs of specMaps) {
            for (const [depName, depRange] of Object.entries(specs ?? {})) {
              deps.push({ name: depName, range: depRange })
            }
          }
          return { entry: { name: spec.name, version, meta }, deps }
        }),
      )
      results.push(...chunkResults)
    }

    const nextFrontier: Array<{ name: string; range: string }> = []
    for (const result of results) {
      if (!result) continue
      plan.push(result.entry)
      nextFrontier.push(...result.deps)
    }
    frontier = nextFrontier
  }
  return plan
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export interface InstallOptions {
  timeoutMs?: number
  /** max concurrent downloads; defaults to 4, overridable via DSH_DOWNLOAD_CONCURRENCY */
  concurrency?: number
  /** per-package download+extract attempts before giving up (default 3) */
  retries?: number
  onProgress?: (e: RuntimeProgressEvent) => void
  /** injectable plan resolver (tests); defaults to resolveClosure */
  resolve?: (
    specs: Array<{ name: string; range: string }>,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    onResolve?: (done: number) => void,
  ) => Promise<PlanEntry[]>
  /** injectable tarball downloader (tests); defaults to the mirror-resolving downloadTarball path */
  download?: (entry: PlanEntry, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<Buffer>
  /** injectable extractor (tests); defaults to extractInto */
  extract?: (buffer: Buffer, nodeModules: string, name: string) => Promise<void>
}

/** Default download: prefer metadata-supplied tarball+integrity, else registry-style URL. */
async function defaultInstallDownload(
  entry: PlanEntry,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Buffer> {
  const { name, version, meta } = entry
  const registry = env.DSH_NPM_MIRROR?.replace(/\/$/, '') ?? NPM_REGISTRIES[0]
  const sources =
    meta.dist?.tarball && meta.dist.integrity
      ? [{ url: meta.dist.tarball, source: 'origin' as const }]
      : [
          {
            url: `${registry}/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
            source: 'mirror' as const,
          },
        ]
  const firstSource = sources[0]
  const { buffer } = await downloadTarball(sources, {
    integrity: firstSource?.source === 'origin' ? meta.dist?.integrity : undefined,
    timeoutMs,
  })
  return buffer
}

const defaultInstallExtract = extractInto

/** Runs `work` for every item with a fixed worker count, awaiting all workers. */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = next
      next += 1
      if (current >= items.length) return
      const item = items[current]
      if (item === undefined) return
      await work(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Downloads each entry in `plan` into nodeModules, mirroring npm's flat layout.
 *
 * Resumable: every fully-extracted package is stamped with INSTALL_MARKER and
 * skipped on retry, so an interrupted first launch continues where it left off
 * instead of restarting the platform runtime fetch from zero. Packages download
 * in parallel (default concurrency 4, DSH_DOWNLOAD_CONCURRENCY overrides); a
 * failure in any package rejects the whole install while keeping already
 * extracted packages installed for the next resumable run.
 */
export async function installClosure(
  rootSpecs: Array<{ name: string; range: string }>,
  nodeModules: string,
  env: NodeJS.ProcessEnv = {},
  options: InstallOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000
  const resolve = options.resolve ?? resolveClosure
  const download = options.download ?? defaultInstallDownload
  const extract = options.extract ?? defaultInstallExtract
  const retries = Math.max(1, Math.floor(options.retries ?? 3))
  const rawConcurrency = Number(env.DSH_DOWNLOAD_CONCURRENCY)
  const envConcurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.floor(rawConcurrency)
      : undefined
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? envConcurrency ?? 4))

  // Phase 1: resolve everything first (metadata only) so we can show a real
  // percentage during the much heavier Phase 2 downloads. Progress is reported
  // per package during the resolve so the UI is not silent for minutes.
  const plan = await resolve(rootSpecs, env, timeoutMs, (done) => {
    options.onProgress?.({ stage: 'resolve', done })
  })
  options.onProgress?.({ stage: 'resolve', done: plan.length, total: plan.length })

  const pending = plan.filter((entry) => !isFullyInstalled(moduleDir(nodeModules, entry.name)))
  let done = plan.length - pending.length // already satisfied by earlier runs
  let bytesTotal = 0

  const installOne = async (entry: PlanEntry): Promise<void> => {
    let lastError: unknown
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const buffer = await download(entry, env, timeoutMs)
        await extract(buffer, nodeModules, entry.name)
        bytesTotal += buffer.byteLength
        done += 1
        const percent = plan.length === 0 ? 100 : Math.round((done / plan.length) * 100)
        options.onProgress?.({
          stage: 'fetch',
          name: entry.name,
          done,
          total: plan.length,
          bytes: bytesTotal,
          percent,
        })
        console.log(
          `[fetch-runtime] + ${entry.name}@${entry.version} (${done}/${plan.length}, ${percent}%, ${formatBytes(bytesTotal)})`,
        )
        return
      } catch (error) {
        lastError = error
        if (attempt < retries) {
          const delay = 300 * attempt
          console.warn(
            `[fetch-runtime] retry ${entry.name}@${entry.version} (${attempt}/${retries - 1}) in ${delay}ms: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
        }
      }
    }
    throw lastError
  }

  await runWithConcurrency(pending, concurrency, installOne)

  options.onProgress?.({ stage: 'done', root: nodeModules })
}

/** Extracts a package tarball so that its contents land at node_modules/<name>. */
async function extractInto(tgzBuffer: Buffer, nodeModules: string, name: string): Promise<void> {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'dsh-pkg-'))
  try {
    const tgz = path.join(staging, 'pkg.tgz')
    await writeFile(tgz, tgzBuffer)
    const extracted = path.join(staging, 'out')
    await mkdir(extracted, { recursive: true })
    // Relative paths + cwd: some tar builds treat "D:\\" as a remote hostname.
    await execFileAsync('tar', ['-xzf', 'pkg.tgz', '-C', 'out'], { windowsHide: true, cwd: staging })
    const entries = await readdir(extracted)
    const root = entries.includes('package') ? 'package' : entries[0]
    if (!root) throw new Error(`empty tarball for ${name}`)
    const source = path.join(extracted, root)
    const destDir = moduleDir(nodeModules, name)
    await mkdir(path.dirname(destDir), { recursive: true })
    // Remove any stale/partial destination first, then place the fresh copy.
    // On Windows AV/indexers briefly hold handles on freshly extracted files,
    // which makes both rm() and rename() fail with EPERM; retry with backoff.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rm(destDir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      }
    }
    try {
      await rename(source, destDir)
    } catch (error) {
      // Cross-directory rename can still be denied on locked-down machines;
      // fall back to a recursive copy so extraction succeeds either way.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EXDEV') throw error
      await cp(source, destDir, { recursive: true })
    }
    await writeFile(path.join(destDir, INSTALL_MARKER), `${new Date().toISOString()}\n`, 'utf8')
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Default per-user cache location for the downloaded runtime. */
export function defaultDownloadCacheDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'harnessdock', 'runtime-cache')
  }
  return path.join(os.homedir(), '.harnessdock', 'runtime-cache')
}

/**
 * Ensures a full vendored dsh install exists under <cacheDir>/runtime-<version>
 * with bin.js at node_modules/@deepseek-ai/dsh/lib/bin.js, building the whole
 * dependency closure from registry mirrors over plain HTTPS when needed.
 * No npm/npx required on the target machine.
 *
 * Resumable: unlike before, a partial install is NOT wiped on retry — already
 * extracted packages (marked with INSTALL_MARKER) are kept and only missing or
 * incomplete ones are re-fetched. Use DSH_RUNTIME_CLEAN=1 to force a fresh
 * download after a corrupted install.
 */
export async function ensureDownloadedRuntime(input: {
  origin: { dshVersion: string; npmPackage?: string; npmTarball?: string; npmIntegrity?: string }
  env: NodeJS.ProcessEnv
  cacheDir: string
  timeoutMs?: number
  onProgress?: (e: RuntimeProgressEvent) => void
}): Promise<{ dshBin: string; runtimeDir: string }> {
  const pkg = input.origin.npmPackage ?? '@deepseek-ai/dsh'
  const version = input.origin.dshVersion
  const runtimeDir = path.join(input.cacheDir, `runtime-${version}`)
  const dshBin = path.join(runtimeDir, 'node_modules', ...pkg.split('/'), 'lib', 'bin.js')
  const marker = path.join(runtimeDir, '.ready')

  if (existsSync(dshBin) && existsSync(marker)) {
    return { dshBin, runtimeDir }
  }

  if (input.env.DSH_RUNTIME_CLEAN === '1') {
    await rm(runtimeDir, { recursive: true, force: true })
  }

  const nodeModules = path.join(runtimeDir, 'node_modules')
  await mkdir(nodeModules, { recursive: true })

  // Root package: honor the pinned integrity from origin.json when downloading
  // through the pinned official URL; mirror-built URLs verify via metadata.
  const rootAlreadyInstalled = isFullyInstalled(moduleDir(nodeModules, pkg))
  if (!rootAlreadyInstalled) {
    let rootBuffer: Buffer
    const pinnedUrl = input.env.DSH_NPM_TARBALL_URL
    if (pinnedUrl) {
      rootBuffer = (await downloadTarball([{ url: pinnedUrl, source: 'env' }], {
        timeoutMs: input.timeoutMs,
      })).buffer
    } else {
      const candidates = resolveTarballCandidates(
        { npmPackage: pkg, version, npmTarball: input.origin.npmTarball },
        input.env,
      )
      const primary = candidates[0]
      if (!primary) throw new Error('no tarball candidate available')
      rootBuffer = (
        await downloadTarball([primary], {
          integrity: primary.source === 'origin' ? input.origin.npmIntegrity : undefined,
          timeoutMs: input.timeoutMs,
        })
      ).buffer
    }
    await extractInto(rootBuffer, nodeModules, pkg)

    const rootPkgRaw = JSON.parse(
      await readFile(path.join(moduleDir(nodeModules, pkg), 'package.json'), 'utf8'),
    ) as { version?: string }
    if (rootPkgRaw.version !== version) {
      throw new Error(`downloaded ${pkg} version ${rootPkgRaw.version} != pinned ${version}`)
    }
  }

  const rootPkgRaw = JSON.parse(
    await readFile(path.join(moduleDir(nodeModules, pkg), 'package.json'), 'utf8'),
  ) as {
    version?: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }

  const rootDeps: Array<{ name: string; range: string }> = []
  for (const specs of [
    rootPkgRaw.dependencies,
    rootPkgRaw.optionalDependencies,
    rootPkgRaw.peerDependencies,
  ]) {
    for (const [name, range] of Object.entries(specs ?? {})) {
      rootDeps.push({ name, range })
    }
  }
  await installClosure(
    rootDeps,
    nodeModules,
    input.env,
    { timeoutMs: input.timeoutMs, onProgress: input.onProgress },
  )

  if (!existsSync(dshBin)) {
    throw new Error(`dsh bin.js not found after extraction: ${dshBin}`)
  }

  const repairedAssets = await repairKnownRuntimeAssets(runtimeDir)
  if (repairedAssets.length > 0) {
    console.log(`[fetch-runtime] repaired known upstream assets: ${repairedAssets.join(', ')}`)
  }

  // Prune the vendored runtime for the host platform (same rules as the bundled
  // prepare:runtime): drop other-platform native variants (koffi/ripgrep/@img),
  // non-host prebuilds and dev/debug files. Saves ~50-100 MB on every download.
  // Runs BEFORE the .ready marker so an interrupted prune is re-run on resume.
  const pruned = await pruneBundledRuntime(runtimeDir, process.platform, process.arch)
  if (pruned.removedCount > 0) {
    console.log(
      `[fetch-runtime] pruned ${pruned.removedCount} items (${(pruned.removedBytes / 1024 / 1024).toFixed(1)} MB) for ${process.platform}/${process.arch}`,
    )
  }
  await assertBundledRuntimeIntegrity(runtimeDir, process.platform, process.arch)

  await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8')
  input.onProgress?.({ stage: 'done', root: runtimeDir })
  return { dshBin, runtimeDir }
}