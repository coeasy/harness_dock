import { createHash } from 'node:crypto'

/**
 * Registry-style mirrors tried in order when the official tarball is
 * unreachable. A third-party machine may only have access to one of these
 * (or an intranet mirror injected via DSH_NPM_MIRROR).
 */
export const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'] as const

export interface TarballCandidate {
  url: string
  /** where the candidate came from; used for logs and tests */
  source: 'env' | 'origin' | 'mirror'
}

/** Builds a registry-style tarball URL: <registry>/<pkg>/-/<name>-<version>.tgz */
export function tarballUrlFor(registry: string, npmPackage: string, version: string): string {
  const base = registry.replace(/\/$/, '')
  const name = npmPackage.startsWith('@')
    ? npmPackage.slice(npmPackage.indexOf('/') + 1)
    : npmPackage
  return `${base}/${npmPackage}/-/${name}-${version}.tgz`
}

/**
 * Ordered candidate list: explicit override first (DSH_NPM_TARBALL_URL), then
 * the pinned official tarball from origin.json, then each registry mirror
 * (env DSH_NPM_MIRROR prepends an intranet mirror).
 */
export function resolveTarballCandidates(
  input: {
    npmPackage: string
    version: string
    npmTarball?: string
  },
  env: NodeJS.ProcessEnv = {},
): TarballCandidate[] {
  const candidates: TarballCandidate[] = []
  const registries = [
    ...(env.DSH_NPM_MIRROR ? [env.DSH_NPM_MIRROR] : []),
    ...NPM_REGISTRIES,
  ]
  if (env.DSH_NPM_TARBALL_URL) {
    candidates.push({ url: env.DSH_NPM_TARBALL_URL, source: 'env' })
  }
  if (input.npmTarball) {
    candidates.push({ url: input.npmTarball, source: 'origin' })
  }
  for (const registry of registries) {
    candidates.push({ url: tarballUrlFor(registry, input.npmPackage, input.version), source: 'mirror' })
  }
  // de-dup, keep first occurrence
  const seen = new Set<string>()
  return candidates.filter((c) => !seen.has(c.url) && seen.add(c.url))
}

export function matchesIntegrity(buffer: Uint8Array, integrity?: string): boolean {
  if (!integrity) return true
  const [algorithm, expected] = integrity.split('-', 2)
  if (!algorithm || !expected) return false
  try {
    const actual = createHash(algorithm).update(buffer).digest('base64')
    return actual === expected
  } catch {
    // unknown digest algorithm or malformed integrity string
    return false
  }
}

/**
 * Hard deadline race. `AbortSignal.timeout` alone does not always interrupt a
 * wedged undici socket (observed: a fetch that never settles), which would make
 * a single stuck tarball stall the whole first-launch forever. Racing against a
 * timer guarantees the caller gets a rejection at the deadline; the underlying
 * fetch is still given its own abort signal so it can release its socket.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function downloadTarball(
  candidates: TarballCandidate[],
  options: { integrity?: string; timeoutMs?: number },
): Promise<{ buffer: Buffer; url: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const errors: string[] = []
  for (const candidate of candidates) {
    try {
      const response = await withTimeout(
        fetch(candidate.url, { signal: AbortSignal.timeout(timeoutMs) }),
        timeoutMs,
        `GET ${candidate.url}`,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(
        await withTimeout(response.arrayBuffer(), timeoutMs, `read ${candidate.url}`),
      )
      if (!matchesIntegrity(buffer, options.integrity)) {
        throw new Error(`integrity mismatch (expected ${options.integrity})`)
      }
      return { buffer, url: candidate.url }
    } catch (error) {
      errors.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`all tarball sources failed:\n${errors.join('\n')}`)
}
