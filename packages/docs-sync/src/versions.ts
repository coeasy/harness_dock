const TAG_PREFIX = 'dsh-v'
const FLOATING_TAGS = new Set(['latest', 'next'])

export function gitTagToVersion(tag: string): string | null {
  if (!tag.startsWith(TAG_PREFIX)) return null
  const version = tag.slice(TAG_PREFIX.length)
  return version.length > 0 ? version : null
}

export function versionToGitTag(version: string): string {
  return `${TAG_PREFIX}${rejectFloatingDistTag(version)}`
}

export function rejectFloatingDistTag(pin: string): string {
  if (FLOATING_TAGS.has(pin.trim().toLowerCase())) {
    throw new Error(
      `Refusing npm dist-tag pin "${pin}". Use an exact version (git tag ∩ npm), never latest/next.`,
    )
  }
  return pin
}

export function intersectVersions(gitVersions: string[], npmVersions: string[]): string[] {
  const npm = new Set(npmVersions)
  return gitVersions.filter((version) => npm.has(version))
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    const da = pa.core[i] ?? 0
    const db = pb.core[i] ?? 0
    if (da !== db) return da - db
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  if (pa.pre.kind !== pb.pre.kind) return pa.pre.kind.localeCompare(pb.pre.kind)
  return pa.pre.n - pb.pre.n
}

export function pickLatestVersion(versions: string[]): string {
  if (versions.length === 0) {
    throw new Error('No versions in git tag ∩ npm intersection')
  }
  return [...versions].sort(compareVersions).at(-1) as string
}

function parseVersion(version: string): {
  core: [number, number, number]
  pre: { kind: string; n: number } | null
} {
  const [corePart, prePart] = version.split('-') as [string, string | undefined]
  const core = corePart.split('.').map((n) => Number.parseInt(n, 10)) as [
    number,
    number,
    number,
  ]
  if (!prePart) return { core, pre: null }
  const match = /^(rc|alpha|beta)\.(\d+)$/i.exec(prePart)
  if (!match) return { core, pre: { kind: prePart, n: 0 } }
  return {
    core,
    pre: { kind: match[1]!.toLowerCase(), n: Number.parseInt(match[2]!, 10) },
  }
}
