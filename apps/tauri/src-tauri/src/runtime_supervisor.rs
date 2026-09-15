//! Runtime supervisor foundation for Architecture V3.
//!
//! This layer coordinates runtime lifecycle decisions above RuntimeActor.
//! It does not replace RuntimeLease validation or the existing actor state
//! machine; it provides a future home for health checks, recovery and upgrade
//! orchestration.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupervisorState {
    Idle,
    Starting,
    Monitoring,
    Recovering,
    Upgrading,
    RollingBack,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeHealth {
    pub healthy: bool,
    pub consecutive_failures: u32,
    pub last_check_ms: u128,
}

impl Default for RuntimeHealth {
    fn default() -> Self {
        Self {
            healthy: false,
            consecutive_failures: 0,
            last_check_ms: 0,
        }
    }
}

#[derive(Debug)]
pub struct RuntimeSupervisor {
    state: SupervisorState,
    health: RuntimeHealth,
    started_at: Instant,
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self {
            state: SupervisorState::Idle,
            health: RuntimeHealth::default(),
            started_at: Instant::now(),
        }
    }
}

impl RuntimeSupervisor {
    pub fn state(&self) -> SupervisorState {
        self.state
    }

    pub fn health(&self) -> &RuntimeHealth {
        &self.health
    }

    pub fn start_monitoring(&mut self) {
        self.state = SupervisorState::Monitoring;
        self.health.healthy = true;
        self.health.consecutive_failures = 0;
    }

    pub fn mark_failure(&mut self) {
        self.health.healthy = false;
        self.health.consecutive_failures = self.health.consecutive_failures.saturating_add(1);
        self.health.last_check_ms = self.started_at.elapsed().as_millis();
    }

    pub fn begin_recovery(&mut self) {
        self.state = SupervisorState::Recovering;
    }

    pub fn begin_upgrade(&mut self) {
        self.state = SupervisorState::Upgrading;
    }

    pub fn begin_rollback(&mut self) {
        self.state = SupervisorState::RollingBack;
    }

    pub fn stop(&mut self) {
        self.state = SupervisorState::Stopping;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_enters_monitoring() {
        let mut supervisor = RuntimeSupervisor::default();
        supervisor.start_monitoring();
        assert_eq!(supervisor.state(), SupervisorState::Monitoring);
        assert!(supervisor.health().healthy);
    }

    #[test]
    fn supervisor_tracks_failure() {
        let mut supervisor = RuntimeSupervisor::default();
        supervisor.mark_failure();
        assert_eq!(supervisor.health().consecutive_failures, 1);
        assert!(!supervisor.health().healthy);
    }
}
