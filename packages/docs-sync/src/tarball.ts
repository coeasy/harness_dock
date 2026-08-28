import type { NpmPackageMeta, TarballInspection } from './types.ts'

const MIN_FILE_COUNT = 5

export function inspectPublishedPackage(meta: NpmPackageMeta): TarballInspection {
  if (!meta.bin || typeof meta.bin.dsh !== 'string' || meta.bin.dsh.length === 0) {
    return { ok: false, reason: `package ${meta.version} has no dsh bin` }
  }
  const fileCount = meta.dist?.fileCount ?? 0
  if (fileCount < MIN_FILE_COUNT) {
    return {
      ok: false,
      reason: `package ${meta.version} looks like an empty shell (fileCount=${fileCount})`,
    }
  }
  const integrity = meta.dist?.integrity
  const tarball = meta.dist?.tarball
  if (!integrity || !tarball) {
    return { ok: false, reason: `package ${meta.version} is missing dist integrity/tarball` }
  }
  return { ok: true, integrity, tarball }
}
