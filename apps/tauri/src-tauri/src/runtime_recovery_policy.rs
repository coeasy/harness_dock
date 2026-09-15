//! Runtime recovery policy foundation.
//!
//! Defines bounded recovery decisions separately from RuntimeActor state.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    Ignore,
    RetryProbe,
    RestartRuntime,
    EnterRecoveryUi,
}

#[derive(Debug, Clone)]
pub struct RuntimeRecoveryPolicy {
    pub max_failures_before_restart: u32,
    pub max_restart_attempts: u32,
}

impl Default for RuntimeRecoveryPolicy {
    fn default() -> Self {
        Self {
            max_failures_before_restart: 3,
            max_restart_attempts: 2,
        }
    }
}

impl RuntimeRecoveryPolicy {
    pub fn decide(&self, failures: u32, restart_attempts: u32) -> RecoveryDecision {
        if failures < self.max_failures_before_restart {
            return RecoveryDecision::RetryProbe;
        }

        if restart_attempts < self.max_restart_attempts {
            return RecoveryDecision::RestartRuntime;
        }

        RecoveryDecision::EnterRecoveryUi
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_escalates_after_retries() {
        let policy = RuntimeRecoveryPolicy::default();
        assert_eq!(
            policy.decide(3, 0),
            RecoveryDecision::RestartRuntime
        );
        assert_eq!(
            policy.decide(3, 2),
            RecoveryDecision::EnterRecoveryUi
        );
    }
}
