// Backward-compatible facade. Host-owned readiness parsing now lives under
// `src/host/`; keep this path stable while downstream consumers migrate.
export { parseReadyFile } from './host/ready.ts'
export type { ReadyExpectation } from './host/ready.ts'
