import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathIsWithin, sanitizeDownloadFilename } from './downloads.ts'

export async function canonicalExistingPath(targetPath: string, workspaceRoot?: string): Promise<string> {
  const resolved = await realpath(path.resolve(targetPath))
  if (workspaceRoot) {
    const root = await realpath(path.resolve(workspaceRoot))
    if (!pathIsWithin(root, resolved)) throw new Error('Path is outside the allowed workspace boundary')
  }
  return resolved
}

async function nearestExistingDirectory(directory: string): Promise<{ real: string; missing: string[] }> {
  let probe = path.resolve(directory)
  const missing: string[] = []
  while (true) {
    try {
      return { real: await realpath(probe), missing }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(probe)
      if (parent === probe) throw error
      missing.unshift(path.basename(probe))
      probe = parent
    }
  }
}

/** Resolve a destination without creating any directory before boundary checks. */
export async function canonicalDestinationPath(targetPath: string, workspaceRoot?: string): Promise<string> {
  const absolute = path.resolve(targetPath)
  const safeName = sanitizeDownloadFilename(path.basename(absolute))
  const parentInfo = await nearestExistingDirectory(path.dirname(absolute))
  const resolvedParent = path.join(parentInfo.real, ...parentInfo.missing)
  const resolved = path.join(resolvedParent, safeName)
  if (workspaceRoot) {
    const root = await realpath(path.resolve(workspaceRoot))
    if (!pathIsWithin(root, resolvedParent) || !pathIsWithin(root, resolved)) {
      throw new Error('Destination is outside the allowed workspace boundary')
    }
  }
  return resolved
}
