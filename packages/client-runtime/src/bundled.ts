import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Matches dsh engines floor: ^22.19.0 || >=24.0.0 */
export const NODE_BUNDLE_VERSION = '22.19.0'

export const NODE_DIST_MIRRORS = [
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
] as const

export interface NodeDist {
  url: string
  kind: 'file' | 'tar.gz' | 'tar.xz'
  nodeRel: string
}

export interface BundledLayout {
  nodeBin: string
  dshBin: string
}

export function bundledNodeRel(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : path.join('bin', 'node')
}

export function bundledDshBin(root: string): string {
  return path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function nodeOfficialUrl(
  nodeVersion: string,
  platform: NodeJS.Platform,
  arch: string,
  mirror: string = NODE_DIST_MIRRORS[0],
): NodeDist {
  const base = mirror.replace(/\/$/, '')
  if (platform === 'win32') {
    const npmArch = arch === 'ia32' ? 'x86' : arch
    return {
      url: `${base}/v${nodeVersion}/win-${npmArch}/node.exe`,
      kind: 'file',
      nodeRel: 'node.exe',
    }
  }
  const plat = platform === 'darwin' ? 'darwin' : 'linux'
  const ext = platform === 'linux' ? 'tar.xz' : 'tar.gz'
  return {
    url: `${base}/v${nodeVersion}/node-v${nodeVersion}-${plat}-${arch}.${ext}`,
    kind: ext,
    nodeRel: path.join('bin', 'node'),
  }
}

export function inspectBundledRuntime(
  root: string,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean = existsSync,
): BundledLayout | null {
  const nodeBin = path.join(root, bundledNodeRel(platform))
  const dshBin = bundledDshBin(root)
  if (!exists(nodeBin) || !exists(dshBin)) return null
  return { nodeBin, dshBin }
}

/**
 * The dsh version pinned inside a bundled runtime: prefers the manifest written
 * by prepare-cli, falls back to the vendored @deepseek-ai/dsh package.json.
 * Used to decide whether the bundled seed already matches the requested pin.
 */
export function bundledRuntimeVersion(
  root: string,
  read: (filePath: string) => string = (p) => readFileSync(p, 'utf8'),
): string | null {
  try {
    const manifest = JSON.parse(read(path.join(root, 'manifest.json'))) as { dshVersion?: unknown }
    if (typeof manifest.dshVersion === 'string' && manifest.dshVersion.length > 0) {
      return manifest.dshVersion
    }
  } catch {
    // no manifest; fall through to the package.json
  }
  try {
    const pkg = JSON.parse(
      read(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    ) as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version
    }
  } catch {
    // not a bundled runtime
  }
  return null
}

export function runtimeCacheDir(repoRoot: string): string {
  return path.join(repoRoot, 'runtimes', 'pack')
}

export function canCopyHostNode(input: {
  hostPlatform: NodeJS.Platform
  targetPlatform: NodeJS.Platform
  electronVersion?: string
}): boolean {
  return input.hostPlatform === input.targetPlatform && !input.electronVersion
}
