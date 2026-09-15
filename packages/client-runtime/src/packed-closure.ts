export interface PackedPackageMeta {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * Resolve only the locally packed packages that a runtime entry actually needs.
 *
 * Upstream's release verification puts every tarball at the consumer root so
 * unpublished cross-family peer dependencies can resolve. Doing that for a
 * shipped runtime also installs testkits, alternate integrations and their
 * external dependency trees. Starting from @deepseek-ai/dsh and following
 * required dependencies plus non-optional peers preserves the same local-pack
 * resolution guarantee without turning unrelated release-family packages into
 * runtime dependencies.
 *
 * optionalDependencies and optional peers are intentionally not traversed here.
 * The source-pack install uses --omit=optional, matching upstream's clean-install
 * verification. HarnessDock then installs the target-native packages required by
 * its integrity contract explicitly.
 */
export function resolvePackedRuntimeClosure(
  packages: ReadonlyMap<string, PackedPackageMeta>,
  entryName = '@deepseek-ai/dsh',
): string[] {
  if (!packages.has(entryName)) {
    throw new Error(`packed runtime does not contain ${entryName}`)
  }

  const selected = new Set<string>()
  const pending = [entryName]

  while (pending.length > 0) {
    const name = pending.pop()!
    if (selected.has(name)) continue
    const pkg = packages.get(name)
    if (!pkg) continue
    selected.add(name)

    const required = new Set(Object.keys(pkg.dependencies ?? {}))
    for (const peerName of Object.keys(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[peerName]?.optional) continue
      required.add(peerName)
    }

    for (const dependencyName of required) {
      if (packages.has(dependencyName) && !selected.has(dependencyName)) {
        pending.push(dependencyName)
      }
    }
  }

  return [...selected].sort()
}
