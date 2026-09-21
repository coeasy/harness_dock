//! Generation-aware Runtime supervisor.
//!
//! RuntimeActor remains the owner of the live process and RuntimeLease. This
//! supervisor records lifecycle policy above that actor and rejects stale or
//! impossible transitions so diagnostics/recovery never describe a different
//! generation than the process actually being managed.

use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupervisorState {
    Idle,
    Starting,
    Monitoring,
    Degraded,
    Recovering,
    Upgrading,
    RollingBack,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeHealth {
    pub healthy: bool,
    pub generation: Option<u64>,
    pub consecutive_successes: u32,
    pub consecutive_failures: u32,
    pub last_check_ms: u128,
}

impl Default for RuntimeHealth {
    fn default() -> Self {
        Self {
            healthy: false,
            generation: None,
            consecutive_successes: 0,
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

    fn stamp(&mut self) {
        self.health.last_check_ms = self.started_at.elapsed().as_millis();
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), String> {
        if self.health.generation == Some(generation) {
            Ok(())
        } else {
            Err(format!(
                "stale Runtime supervisor generation: expected {:?}, got {generation}",
                self.health.generation
            ))
        }
    }

    pub fn begin_start(&mut self, generation: u64) -> Result<(), String> {
        if generation == 0 {
            return Err("Runtime supervisor generation must be non-zero".into());
        }
        if !matches!(self.state, SupervisorState::Idle | SupervisorState::Failed) {
            return Err(format!(
                "Runtime supervisor cannot start from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::Starting;
        self.health.healthy = false;
        self.health.generation = Some(generation);
        self.health.consecutive_successes = 0;
        self.health.consecutive_failures = 0;
        self.stamp();
        Ok(())
    }

    pub fn mark_ready(&mut self, generation: u64, degraded: bool) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if !matches!(
            self.state,
            SupervisorState::Starting | SupervisorState::Recovering | SupervisorState::Degraded
        ) {
            return Err(format!(
                "Runtime supervisor cannot publish ready from {:?}",
                self.state
            ));
        }
        self.state = if degraded {
            SupervisorState::Degraded
        } else {
            SupervisorState::Monitoring
        };
        self.health.healthy = true;
        self.health.consecutive_successes =
            self.health.consecutive_successes.saturating_add(1);
        self.health.consecutive_failures = 0;
        self.stamp();
        Ok(())
    }

    pub fn mark_health_failure(&mut self, generation: u64) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if !matches!(
            self.state,
            SupervisorState::Monitoring | SupervisorState::Degraded
        ) {
            return Err(format!(
                "Runtime supervisor cannot record health failure from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::Degraded;
        self.health.healthy = false;
        self.health.consecutive_successes = 0;
        self.health.consecutive_failures =
            self.health.consecutive_failures.saturating_add(1);
        self.stamp();
        Ok(())
    }

    pub fn mark_start_failed(&mut self, generation: u64) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if !matches!(
            self.state,
            SupervisorState::Starting | SupervisorState::Recovering
        ) {
            return Err(format!(
                "Runtime supervisor cannot fail startup from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::Failed;
        self.health.healthy = false;
        self.health.consecutive_successes = 0;
        self.health.consecutive_failures =
            self.health.consecutive_failures.saturating_add(1);
        self.stamp();
        Ok(())
    }

    pub fn mark_process_exited(&mut self, generation: u64) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if self.state == SupervisorState::Stopping {
            return Ok(());
        }
        self.state = SupervisorState::Failed;
        self.health.healthy = false;
        self.health.consecutive_successes = 0;
        self.health.consecutive_failures =
            self.health.consecutive_failures.saturating_add(1);
        self.stamp();
        Ok(())
    }

    pub fn begin_recovery(&mut self, generation: u64) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if !matches!(
            self.state,
            SupervisorState::Starting
                | SupervisorState::Monitoring
                | SupervisorState::Degraded
                | SupervisorState::Failed
        ) {
            return Err(format!(
                "Runtime supervisor cannot recover from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::Recovering;
        self.health.healthy = false;
        self.stamp();
        Ok(())
    }

    pub fn begin_upgrade(&mut self) -> Result<(), String> {
        if !matches!(
            self.state,
            SupervisorState::Monitoring | SupervisorState::Degraded
        ) {
            return Err(format!(
                "Runtime supervisor cannot upgrade from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::Upgrading;
        Ok(())
    }

    pub fn begin_rollback(&mut self) -> Result<(), String> {
        if !matches!(
            self.state,
            SupervisorState::Upgrading | SupervisorState::Failed
        ) {
            return Err(format!(
                "Runtime supervisor cannot roll back from {:?}",
                self.state
            ));
        }
        self.state = SupervisorState::RollingBack;
        Ok(())
    }

    pub fn begin_stop(&mut self) {
        if self.state != SupervisorState::Idle {
            self.state = SupervisorState::Stopping;
            self.health.healthy = false;
            self.stamp();
        }
    }

    pub fn settle_stopped(&mut self) {
        self.state = SupervisorState::Idle;
        self.health.healthy = false;
        self.health.generation = None;
        self.health.consecutive_successes = 0;
        self.health.consecutive_failures = 0;
        self.stamp();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_is_bound_to_current_generation() {
        let mut supervisor = RuntimeSupervisor::default();
        supervisor.begin_start(7).unwrap();
        assert!(supervisor.mark_ready(6, false).is_err());
        supervisor.mark_ready(7, false).unwrap();
        assert_eq!(supervisor.state(), SupervisorState::Monitoring);
        assert_eq!(supervisor.health().generation, Some(7));
    }

    #[test]
    fn degraded_ready_remains_available() {
        let mut supervisor = RuntimeSupervisor::default();
        supervisor.begin_start(3).unwrap();
        supervisor.mark_ready(3, true).unwrap();
        assert_eq!(supervisor.state(), SupervisorState::Degraded);
        assert!(supervisor.health().healthy);
    }

    #[test]
    fn stop_clears_generation_ownership() {
        let mut supervisor = RuntimeSupervisor::default();
        supervisor.begin_start(11).unwrap();
        supervisor.begin_stop();
        supervisor.settle_stopped();
        assert_eq!(supervisor.state(), SupervisorState::Idle);
        assert_eq!(supervisor.health().generation, None);
    }
}
