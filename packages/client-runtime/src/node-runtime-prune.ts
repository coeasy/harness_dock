import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Node's official archives are developer distributions. HarnessDock only needs
 * the Node executable to launch the already-prepared dsh production closure.
 * npm is used by the candidate builder before packaging, not by first launch.
 *
 * Keep the Node executable and LICENSE. Remove only paths that are not needed
 * to execute JavaScript: package managers, headers, man pages and docs. On
 * Windows dsh shares the root node_modules directory, so prune only Node's
 * package-manager subtrees rather than the directory itself.
 */
export function plannedNodeDistributionPrune(platform: NodeJS.Platform): string[] {
  const common = ['README.md', 'CHANGELOG.md']
  if (platform === 'win32') {
    return [
      ...common,
      'npm',
      'npm.cmd',
      'npx',
      'npx.cmd',
      'corepack',
      'corepack.cmd',
      'install_tools.bat',
      'nodevars.bat',
      path.join('node_modules', 'npm'),
      path.join('node_modules', 'corepack'),
    ]
  }
  return [
    ...common,
    path.join('bin', 'npm'),
    path.join('bin', 'npx'),
    path.join('bin', 'corepack'),
    'include',
    'share',
    path.join('lib', 'node_modules'),
  ]
}

async function sizeOf(target: string): Promise<number> {
  let info
  try {
    info = await lstat(target)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size

  let total = 0
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await sizeOf(path.join(target, entry.name))
  }
  return total
}

export async function pruneBundledNodeDistribution(
  root: string,
  platform: NodeJS.Platform,
  log: (message: string) => void = (message) => console.log(`[node-prune] ${message}`),
): Promise<{ removedBytes: number; removedCount: number }> {
  let removedBytes = 0
  let removedCount = 0

  for (const relative of plannedNodeDistributionPrune(platform)) {
    const target = path.join(root, relative)
    const bytes = await sizeOf(target)
    if (bytes === 0) continue
    await rm(target, { recursive: true, force: true })
    removedBytes += bytes
    removedCount += 1
  }

  if (removedCount > 0) {
    log(`removed ${removedCount} Node distribution items (${(removedBytes / 1024 / 1024).toFixed(1)} MB)`)
  }
  return { removedBytes, removedCount }
}
