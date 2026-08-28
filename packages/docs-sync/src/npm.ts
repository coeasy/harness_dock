import type { NpmPackageMeta } from './types.ts'

const PACKUMENT = 'https://registry.npmjs.org/@deepseek-ai/dsh'

export async function listNpmVersions(
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(PACKUMENT, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`npm packument failed: ${response.status}`)
  }
  const body = (await response.json()) as { versions?: Record<string, unknown> }
  return Object.keys(body.versions ?? {})
}

export async function fetchNpmPackageMeta(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NpmPackageMeta> {
  const response = await fetchImpl(`${PACKUMENT}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`npm view @deepseek-ai/dsh@${version} failed: ${response.status}`)
  }
  const body = (await response.json()) as {
    version: string
    bin?: Record<string, string>
    dist?: { fileCount?: number; integrity?: string; tarball?: string }
  }
  return {
    version: body.version,
    bin: body.bin,
    dist: body.dist,
  }
}
