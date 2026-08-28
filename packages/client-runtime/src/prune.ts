/**
 * Plan which @img/sharp / @img/sharp-libvips native variants can be pruned
 * from the bundled dsh runtime, plus generic runtime-size pruning for the
 * "full" desktop package.
 *
 * npm installs every platform's optional native binary for sharp and ships
 * cross-platform prebuilds (node-pty) plus dev/debug files (.map/.pdb/.d.ts),
 * SDK dev/example directories (test/examples/docs), and doc/declaration files
 * (README.md, .d.mts/.d.cts). The full package only ever runs on a single
 * host platform, so everything that is not for that host is dead weight.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const SHARP_PREFIX = '@img/sharp-'
const SHARP_LIBVIPS_PREFIX = '@img/sharp-libvips-'
const WASM_FALLBACK = '@img/sharp-wasm32'
const KEEP_ARCHES = new Set(['x64', 'arm64'])

/**
 * Given the list of installed package names (e.g. the directories under
 * `node_modules/@img` mapped back to their scoped names like
 * `@img/sharp-win32-x64`), return the names that should be deleted because
 * they are @img/sharp / @img/sharp-libvips variants for a different platform
 * than the one the runtime will actually run on.
 *
 * Kept:
 *  - `@img/sharp-wasm32` (universal fallback)
 *  - `@img/sharp-<platform>-<arch>` and `@img/sharp-libvips-<platform>-<arch>`
 *    for the host platform (linux keeps both `linux` and `linuxmusl`).
 *
 * Everything else is untouched: only the @img/sharp and @img/sharp-libvips
 * prefixes are ever considered for deletion.
 */
export function planRuntimePrune(
  packageNames: string[],
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const keep = new Set<string>([WASM_FALLBACK])
  if (KEEP_ARCHES.has(arch)) {
    const keepPlatforms =
      platform === 'win32'
        ? ['win32']
        : platform === 'darwin'
          ? ['darwin']
          : ['linux', 'linuxmusl']
    for (const p of keepPlatforms) {
      keep.add(`${SHARP_PREFIX}${p}-${arch}`)
      keep.add(`${SHARP_LIBVIPS_PREFIX}${p}-${arch}`)
    }
  }
  return packageNames.filter((name) => {
    const isSharpVariant =
      name.startsWith(SHARP_PREFIX) || name.startsWith(SHARP_LIBVIPS_PREFIX)
    return isSharpVariant && !keep.has(name)
  })
}

/**
 * Which `prebuilds/<variant>` subdirectory names (e.g. `win32-x64`) are dead
 * weight for a runtime that only ever runs on the host platform/arch. Used for
 * packages like node-pty that ship every platform's native prebuild.
 * Keeps exactly `${platform}-${arch}` (plus `linuxmusl-${arch}` on Linux).
 */
export function planPrebuildPrune(
  prebuildNames: string[],
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const keep = new Set<string>([`${platform}-${arch}`])
  if (platform === 'linux') keep.add(`linuxmusl-${arch}`)
  return prebuildNames.filter((name) => !keep.has(name))
}

/**
 * File basenames that are pure dev/debug weight in a shipped runtime and are
 * never resolved by Node at runtime: source maps, PDB debug symbols, and
 * TypeScript declaration files. Safe to delete from a bundled node_modules.
 */
const DEV_FILE_RE = [/\.map$/i, /\.pdb$/i, /\.d\.ts$/i]

export function planDevFilesToPrune(fileNames: string[]): string[] {
  return fileNames.filter((name) => DEV_FILE_RE.some((re) => re.test(name)))
}

/**
 * SDK dev/example directory names (basenames) that are pure developer weight
 * in a shipped runtime: tests, examples, coverage, and the `.yarn` metadata
 * dir. None of these are ever resolved by Node at runtime.
 *
 * `dirNames` are directory paths **relative to the runtime's `node_modules`**
 * (e.g. `some-pkg/test`, `@scope/pkg/examples`). Only package-top-level dirs
 * are considered — `node_modules/<pkg>/<dirname>` or
 * `node_modules/@scope/<pkg>/<dirname>` — so a `test` dir under `src` or a
 * `test` dir inside `@types/*` is never touched. Case-insensitive so
 * `__TESTS__` / `Example` variants are covered too.
 */
const SDK_DIR_RE = /^(test|tests|__tests__|examples|coverage|\.yarn)$/i

function isPackageTopDir(relName: string): boolean {
  const segs = relName.replace(/\\/g, '/').split('/').filter(Boolean)
  // node_modules/<pkg>/<dirname>
  if (segs.length === 2) return true
  // node_modules/@scope/<pkg>/<dirname> — but never @types/*
  if (segs.length === 3) {
    const scope = segs[0]
    return scope !== undefined && scope.startsWith('@') && scope !== '@types'
  }
  return false
}

export function planSdkDirsToPrune(dirNames: string[]): string[] {
  return dirNames.filter((name) => {
    if (!SDK_DIR_RE.test(path.basename(name))) return false
    return isPackageTopDir(name)
  })
}

/**
 * Runtime doc/declaration files that are pure weight in a shipped runtime:
 *  - Markdown docs (`*.md`) that are not legal/license material — filenames
 *    starting with `license` / `licence` / `notice` / `changelog` (case
 *    insensitive) are kept;
 *  - TypeScript **declaration** modules `.d.mts` / `.d.cts` (the `.d.ts`
 *    form is already handled by planDevFilesToPrune). Actual `.mts` / `.cts`
 *    source modules are NOT pruned — a package entry point may point at them.
 *
 * `fileNames` are basenames. Never matched at runtime, so safe to delete.
 */
const DOC_MD_RE = /\.md$/i
const DOC_KEEP_RE = /^(license|licence|notice|changelog)/i
const DOC_DECL_RE = /\.d\.(mts|cts)$/i

export function planRuntimeDocFilesToPrune(fileNames: string[]): string[] {
  return fileNames.filter((name) => {
    const isMarkdown = DOC_MD_RE.test(name) && !DOC_KEEP_RE.test(name)
    return isMarkdown || DOC_DECL_RE.test(name)
  })
}

/**
 * Orchestrates the runtime size pruning after a bundled runtime is prepared:
 *  - @img/sharp / sharp-libvips variants for other platforms (planRuntimePrune);
 *  - non-host `prebuilds/<variant>` subdirectories (planPrebuildPrune);
 *  - dev/debug files `.map` / `.pdb` / `.d.ts` under node_modules;
 *  - SDK dev/example dirs (`test` / `tests` / `__tests__` / `examples` /
 *    `coverage` / `.yarn`) at package top level (planSdkDirsToPrune);
 *  - doc/declaration files `*.md` (except license/notice/changelog) and
 *    `.d.mts` / `.d.cts` (planRuntimeDocFilesToPrune).
 *
 * Only files under <root>/node_modules are touched; node.exe and package.json
 * at the root are never removed. Returns the total bytes removed.
 */
export async function pruneBundledRuntime(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
  opts: {
    readdirImpl?: typeof readdir
    rmImpl?: typeof rm
    log?: (message: string) => void
  } = {},
): Promise<{ removedBytes: number; removedCount: number }> {
  const { readdirImpl = readdir, rmImpl = rm, log = (m) => console.log(`[prune] ${m}`) } = opts
  const nodeModules = path.join(root, 'node_modules')
  let removedBytes = 0
  let removedCount = 0

  /** Total byte size of a file or of every file under a directory tree. */
  const sizeOf = async (target: string): Promise<number> => {
    try {
      const info = await stat(target)
      if (!info.isDirectory()) return info.size
    } catch {
      return 0
    }
    let total = 0
    const entries = await readdirImpl(target, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(target, entry.name)
      total += entry.isDirectory() ? await sizeOf(full) : ((await stat(full)).size ?? 0)
    }
    return total
  }

  const remove = async (target: string): Promise<void> => {
    removedBytes += await sizeOf(target)
    await rmImpl(target, { recursive: true, force: true })
    removedCount += 1
  }

  try {
    const entries = await readdirImpl(nodeModules, { recursive: true, withFileTypes: true })
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name))
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(e.parentPath, e.name))

    // 1. @img/sharp cross-platform variants (top-level scoped packages).
    const imgDir = path.join(nodeModules, '@img')
    let imgNames: string[] = []
    try {
      const imgEntries = await readdirImpl(imgDir, { withFileTypes: true })
      imgNames = imgEntries.filter((e) => e.isDirectory()).map((e) => `@img/${e.name}`)
    } catch {
      imgNames = []
    }
    for (const scopedName of planRuntimePrune(imgNames, platform, arch)) {
      const name = scopedName.replace(/^@img\//, '')
      await remove(path.join(imgDir, name))
    }

    // 2. Non-host prebuilds/<variant> subdirectories (e.g. node-pty).
    const prebuildDirs = dirs.filter((dir) => path.basename(path.dirname(dir)) === 'prebuilds')
    for (const variant of prebuildDirs) {
      const variantName = path.basename(variant)
      if (planPrebuildPrune([variantName], platform, arch).includes(variantName)) {
        await remove(variant)
      }
    }

    // 3. Dev/debug files (.map / .pdb / .d.ts).
    const devFiles = files.filter((file) => planDevFilesToPrune([path.basename(file)]).length > 0)
    for (const file of devFiles) {
      await remove(file)
    }

    // 4. SDK dev/example dirs (test / tests / __tests__ / examples / coverage
    //    / .yarn) at package top level — not under @types/* or src.
    const sdkDirs = dirs.filter((dir) => {
      const rel = path.relative(nodeModules, dir)
      return planSdkDirsToPrune([rel]).length > 0
    })
    for (const dir of sdkDirs) {
      await remove(dir)
    }

    // 5. Doc/declaration files: *.md except license/notice/changelog, plus
    //    .d.mts / .d.cts declaration modules.
    const docFiles = files.filter(
      (file) => planRuntimeDocFilesToPrune([path.basename(file)]).length > 0,
    )
    for (const file of docFiles) {
      await remove(file)
    }

    if (removedCount > 0) {
      log(`removed ${removedCount} items (${(removedBytes / 1024 / 1024).toFixed(1)} MB)`)
    }
  } catch (error) {
    log(`prune skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { removedBytes, removedCount }
}
