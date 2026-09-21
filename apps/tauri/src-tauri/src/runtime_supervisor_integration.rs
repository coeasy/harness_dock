//! Runtime supervisor integration layer.
//!
//! RuntimeActor remains the process/lease source of truth. Every event carries
//! the generation where identity matters, preventing stale health/recovery
//! signals from mutating the policy state of a newer Runtime.

use crate::runtime_recovery_policy::{RecoveryDecision, RuntimeRecoveryPolicy};
use crate::runtime_supervisor::{RuntimeSupervisor, SupervisorState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEvent {
    StartRequested(u64),
    Ready { generation: u64, degraded: bool },
    StartFailed(u64),
    HealthFailure(u64),
    ProcessExited(u64),
    RecoveryRequested(u64),
    UpgradeRequested,
    RollbackRequested,
    StopRequested,
    Stopped,
}

pub fn apply_event(
    supervisor: &mut RuntimeSupervisor,
    event: RuntimeEvent,
) -> Result<(), String> {
    match event {
        RuntimeEvent::StartRequested(generation) => supervisor.begin_start(generation),
        RuntimeEvent::Ready {
            generation,
            degraded,
        } => supervisor.mark_ready(generation, degraded),
        RuntimeEvent::StartFailed(generation) => supervisor.mark_start_failed(generation),
        RuntimeEvent::HealthFailure(generation) => supervisor.mark_health_failure(generation),
        RuntimeEvent::ProcessExited(generation) => supervisor.mark_process_exited(generation),
        RuntimeEvent::RecoveryRequested(generation) => supervisor.begin_recovery(generation),
        RuntimeEvent::UpgradeRequested => supervisor.begin_upgrade(),
        RuntimeEvent::RollbackRequested => supervisor.begin_rollback(),
        RuntimeEvent::StopRequested => {
            supervisor.begin_stop();
            Ok(())
        }
        RuntimeEvent::Stopped => {
            supervisor.settle_stopped();
            Ok(())
        }
    }
}

pub fn recovery_decision(
    supervisor: &RuntimeSupervisor,
    restart_attempts: u32,
) -> RecoveryDecision {
    RuntimeRecoveryPolicy::default()
        .decide(supervisor.health().consecutive_failures, restart_attempts)
}

pub fn should_recover(supervisor: &RuntimeSupervisor) -> bool {
    matches!(
        recovery_decision(supervisor, 0),
        RecoveryDecision::RestartRuntime | RecoveryDecision::EnterRecoveryUi
    ) || matches!(
        supervisor.state(),
        SupervisorState::Recovering | SupervisorState::Failed
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_events_cannot_mutate_new_generation() {
        let mut supervisor = RuntimeSupervisor::default();
        apply_event(&mut supervisor, RuntimeEvent::StartRequested(9)).unwrap();
        assert!(apply_event(
            &mut supervisor,
            RuntimeEvent::Ready {
                generation: 8,
                degraded: false,
            }
        )
        .is_err());
        apply_event(
            &mut supervisor,
            RuntimeEvent::Ready {
                generation: 9,
                degraded: false,
            },
        )
        .unwrap();
        assert_eq!(supervisor.state(), SupervisorState::Monitoring);
    }

    #[test]
    fn repeated_failures_trigger_recovery_policy() {
        let mut supervisor = RuntimeSupervisor::default();
        apply_event(&mut supervisor, RuntimeEvent::StartRequested(4)).unwrap();
        apply_event(
            &mut supervisor,
            RuntimeEvent::Ready {
                generation: 4,
                degraded: false,
            },
        )
        .unwrap();
        for _ in 0..3 {
            apply_event(&mut supervisor, RuntimeEvent::HealthFailure(4)).unwrap();
        }
        assert!(should_recover(&supervisor));
        assert_eq!(
            recovery_decision(&supervisor, 0),
            RecoveryDecision::RestartRuntime
        );
    }
}
