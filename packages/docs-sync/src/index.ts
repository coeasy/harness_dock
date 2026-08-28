export { extractGuideCapabilities, hashDocs } from './docs.ts'
export { buildCapabilityMatrix, parseDumpConfigMounts, renderCapabilityMatrixYaml } from './matrix.ts'
export { fetchNpmPackageMeta, listNpmVersions } from './npm.ts'
export { buildOrigin, diffOrigin } from './origin.ts'
export { ORIGIN_PATH, MATRIX_PATH, readOriginFile, syncDsh } from './sync.ts'
export { inspectPublishedPackage } from './tarball.ts'
export type { Origin, CapabilityMatrix, GuideCapability } from './types.ts'
export {
  gitTagToVersion,
  intersectVersions,
  pickLatestVersion,
  rejectFloatingDistTag,
  versionToGitTag,
} from './versions.ts'
