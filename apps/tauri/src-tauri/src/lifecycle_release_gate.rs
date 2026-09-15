//! Lifecycle validation gate for final V3 stabilization.
//!
//! Keeps release checks explicit instead of relying only on ad-hoc runtime
//! observations.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleGate {
    Pass,
    Block,
}

#[derive(Debug, Clone, Copy)]
pub struct LifecycleValidation {
    pub runtime_recovery_ready: bool,
    pub startup_path_ready: bool,
    pub shutdown_policy_ready: bool,
    pub diagnostics_ready: bool,
}

impl LifecycleValidation {
    pub fn gate(&self) -> LifecycleGate {
        if self.runtime_recovery_ready
            && self.startup_path_ready
            && self.shutdown_policy_ready
            && self.diagnostics_ready
        {
            LifecycleGate::Pass
        } else {
            LifecycleGate::Block
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_lifecycle_passes() {
        let validation = LifecycleValidation {
            runtime_recovery_ready: true,
            startup_path_ready: true,
            shutdown_policy_ready: true,
            diagnostics_ready: true,
        };
        assert_eq!(validation.gate(), LifecycleGate::Pass);
    }
}
