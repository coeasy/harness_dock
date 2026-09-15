//! Lifecycle integration readiness adapter.
//!
//! Provides a small boundary for connecting startup, runtime, shutdown and
//! diagnostics without coupling their state machines together.

use crate::lifecycle_release_gate::{LifecycleGate, LifecycleValidation};

pub fn release_ready(
    runtime_recovery: bool,
    startup: bool,
    shutdown: bool,
    diagnostics: bool,
) -> LifecycleGate {
    LifecycleValidation {
        runtime_recovery_ready: runtime_recovery,
        startup_path_ready: startup,
        shutdown_policy_ready: shutdown,
        diagnostics_ready: diagnostics,
    }
    .gate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_requires_all_lifecycle_parts() {
        assert_eq!(release_ready(true, true, true, true), LifecycleGate::Pass);
        assert_eq!(release_ready(true, true, true, false), LifecycleGate::Block);
    }
}
