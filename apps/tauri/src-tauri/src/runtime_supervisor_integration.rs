//! Runtime supervisor integration layer.
//!
//! Keeps RuntimeActor as the source of truth and provides policy hooks for
//! recovery, health monitoring and future upgrade orchestration.

use crate::runtime_recovery_policy::{RecoveryAction, RuntimeRecoveryPolicy};
use crate::runtime_supervisor::{RuntimeSupervisor, SupervisorState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEvent {
    Started,
    Ready,
    HealthFailure,
    ProcessExited,
    RecoveryRequested,
    UpgradeRequested,
    RollbackRequested,
}

pub fn apply_event(supervisor: &mut RuntimeSupervisor, event: RuntimeEvent) {
    match event {
        RuntimeEvent::Started | RuntimeEvent::Ready => supervisor.start_monitoring(),
        RuntimeEvent::HealthFailure | RuntimeEvent::ProcessExited => {
            supervisor.mark_failure();
        }
        RuntimeEvent::RecoveryRequested => supervisor.begin_recovery(),
        RuntimeEvent::UpgradeRequested => supervisor.begin_upgrade(),
        RuntimeEvent::RollbackRequested => supervisor.begin_rollback(),
    }
}

pub fn recovery_action(
    supervisor: &RuntimeSupervisor,
    restart_attempts: u32,
) -> RecoveryAction {
    let policy = RuntimeRecoveryPolicy::default();
    policy.decide(
        supervisor.health().consecutive_failures,
        restart_attempts,
    )
}

pub fn should_recover(supervisor: &RuntimeSupervisor) -> bool {
    matches!(
        recovery_action(supervisor, 0),
        RecoveryAction::RestartRuntime | RecoveryAction::EnterRecoveryUi
    ) || supervisor.state() == SupervisorState::Recovering
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_failures_trigger_recovery_policy() {
        let mut supervisor = RuntimeSupervisor::default();
        for _ in 0..3 {
            apply_event(&mut supervisor, RuntimeEvent::HealthFailure);
        }
        assert!(should_recover(&supervisor));
    }
}
