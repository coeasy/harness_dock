import type { DshDistribution, Origin } from './types.ts'

export function buildOrigin(input: {
  dshVersion: string
  gitTag: string
  gitCommit: string
  distribution?: DshDistribution
  npmIntegrity?: string
  npmTarball?: string
  docsHash: string
  clientVersion: string
  now?: string
}): Origin {
  return {
    dshVersion: input.dshVersion,
    gitTag: input.gitTag,
    gitCommit: input.gitCommit,
    distribution: input.distribution ?? 'npm',
    npmPackage: '@deepseek-ai/dsh',
    npmIntegrity: input.npmIntegrity ?? '',
    npmTarball: input.npmTarball ?? '',
    docsHash: input.docsHash,
    syncedAt: input.now ?? new Date().toISOString(),
    clientVersion: input.clientVersion,
  }
}

export function diffOrigin(
  current: Origin,
  next: Origin,
): { changed: boolean; fields: string[] } {
  const fields: string[] = []
  const keys: (keyof Origin)[] = [
    'dshVersion',
    'gitTag',
    'gitCommit',
    'distribution',
    'npmIntegrity',
    'npmTarball',
    'docsHash',
  ]
  for (const key of keys) {
    if (current[key] !== next[key]) fields.push(key)
  }
  return { changed: fields.length > 0, fields }
}
