//! Bounded shutdown policy for V3 lifecycle.
//!
//! Prevents close operations from waiting forever on unhealthy children.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownAction {
    Wait,
    ForceCleanup,
    TerminateTree,
}

#[derive(Debug, Clone, Copy)]
pub struct ShutdownTimeoutPolicy {
    pub graceful_timeout_ms: u64,
    pub force_timeout_ms: u64,
}

impl Default for ShutdownTimeoutPolicy {
    fn default() -> Self {
        Self {
            graceful_timeout_ms: 2000,
            force_timeout_ms: 5000,
        }
    }
}

impl ShutdownTimeoutPolicy {
    pub fn action(&self, elapsed_ms: u64, process_stuck: bool) -> ShutdownAction {
        if !process_stuck && elapsed_ms < self.graceful_timeout_ms {
            return ShutdownAction::Wait;
        }
        if elapsed_ms < self.force_timeout_ms {
            return ShutdownAction::ForceCleanup;
        }
        ShutdownAction::TerminateTree
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escalates_shutdown_actions() {
        let policy = ShutdownTimeoutPolicy::default();
        assert_eq!(policy.action(100, false), ShutdownAction::Wait);
        assert_eq!(policy.action(3000, true), ShutdownAction::ForceCleanup);
        assert_eq!(policy.action(6000, true), ShutdownAction::TerminateTree);
    }
}
