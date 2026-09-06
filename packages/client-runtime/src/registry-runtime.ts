// Compatibility adapter around the legacy fetch-runtime module. New code uses
// the role-specific name so it is no longer confused with the bundle-aware
// `ensureDownloadedRuntime` orchestration exported from ensure-runtime.ts.
export { ensureDownloadedRuntime as ensureRegistryRuntime } from './fetch-runtime.ts'
