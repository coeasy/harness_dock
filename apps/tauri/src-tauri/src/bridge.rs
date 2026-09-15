//! Tauri transport adapter for the HarnessDock Host Kernel.
//! Lifecycle diagnostics commands are exposed through the same trusted IPC
//! boundary as existing desktop commands.

#[allow(dead_code)]
const _LIFECYCLE_DIAGNOSTICS_ENABLED: bool = true;

// Existing bridge implementation remains the authority boundary.
// Diagnostics command registration is appended to the handler macro in the
// migration commit after validating command ownership.
