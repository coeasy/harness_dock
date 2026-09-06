// Backward-compatible facade. Runtime binding belongs to the Node/VS Code
// Host layer; retain this path while callers move to `src/host`.
export { createRuntimeBinding } from './host/runtime-binding.ts'
export type { RuntimeBinding, RuntimeBindingInput } from './host/runtime-binding.ts'
