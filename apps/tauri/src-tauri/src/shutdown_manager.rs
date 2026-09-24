//! Strict shutdown state machine and last-exit report.

use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShutdownPhase {
    Running,
    Requested,
    Freezing,
    StoppingPlugins,
    StoppingRuntime,
    CleaningProcesses,
    ReleasingResources,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ShutdownReport {
    pub duration_ms: Option<u128>,
    pub forced_cleanup: bool,
    pub clean: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ShutdownManager {
    phase: ShutdownPhase,
    force: bool,
    started_at: Option<Instant>,
    report: ShutdownReport,
}

impl Default for ShutdownManager {
    fn default() -> Self {
        Self {
            phase: ShutdownPhase::Running,
            force: false,
            started_at: None,
            report: ShutdownReport::default(),
        }
    }
}

impl ShutdownManager {
    pub fn phase(&self) -> ShutdownPhase {
        self.phase
    }

    pub fn report(&self) -> ShutdownReport {
        self.report
    }

    fn transition(&mut self, expected: ShutdownPhase, next: ShutdownPhase) -> Result<(), String> {
        if self.phase == ShutdownPhase::Completed {
            return Ok(());
        }
        if self.phase == next {
            return Ok(());
        }
        if self.phase != expected {
            return Err(format!(
                "invalid shutdown transition: {:?} -> {:?}",
                self.phase, next
            ));
        }
        self.phase = next;
        Ok(())
    }

    pub fn request(&mut self) -> Result<(), String> {
        if self.phase == ShutdownPhase::Running {
            self.started_at = Some(Instant::now());
            self.report = ShutdownReport::default();
        }
        self.transition(ShutdownPhase::Running, ShutdownPhase::Requested)
    }

    pub fn freeze(&mut self) -> Result<(), String> {
        self.transition(ShutdownPhase::Requested, ShutdownPhase::Freezing)
    }

    pub fn stop_plugins(&mut self) -> Result<(), String> {
        self.transition(ShutdownPhase::Freezing, ShutdownPhase::StoppingPlugins)
    }

    pub fn stop_runtime(&mut self) -> Result<(), String> {
        self.transition(
            ShutdownPhase::StoppingPlugins,
            ShutdownPhase::StoppingRuntime,
        )
    }

    pub fn cleanup_processes(&mut self) -> Result<(), String> {
        self.transition(
            ShutdownPhase::StoppingRuntime,
            ShutdownPhase::CleaningProcesses,
        )
    }

    pub fn release_resources(&mut self) -> Result<(), String> {
        self.transition(
            ShutdownPhase::CleaningProcesses,
            ShutdownPhase::ReleasingResources,
        )
    }

    pub fn complete(&mut self, clean: bool) -> Result<(), String> {
        self.transition(
            ShutdownPhase::ReleasingResources,
            ShutdownPhase::Completed,
        )?;
        self.report.duration_ms = self.started_at.map(|started| started.elapsed().as_millis());
        self.report.forced_cleanup = self.force;
        self.report.clean = Some(clean);
        Ok(())
    }

    pub fn force(&mut self) {
        self.force = true;
        self.report.forced_cleanup = true;
    }

    pub fn is_force(&self) -> bool {
        self.force
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_requires_ordered_progression() {
        let mut manager = ShutdownManager::default();
        manager.request().unwrap();
        manager.freeze().unwrap();
        manager.stop_plugins().unwrap();
        manager.stop_runtime().unwrap();
        manager.cleanup_processes().unwrap();
        manager.release_resources().unwrap();
        manager.complete(true).unwrap();

        assert_eq!(manager.phase(), ShutdownPhase::Completed);
        assert_eq!(manager.report().clean, Some(true));
    }

    #[test]
    fn shutdown_rejects_skipped_stages() {
        let mut manager = ShutdownManager::default();
        manager.request().unwrap();
        assert!(manager.stop_runtime().is_err());
        assert_eq!(manager.phase(), ShutdownPhase::Requested);
    }

    #[test]
    fn forced_cleanup_is_reported() {
        let mut manager = ShutdownManager::default();
        manager.request().unwrap();
        manager.freeze().unwrap();
        manager.force();
        manager.stop_plugins().unwrap();
        manager.stop_runtime().unwrap();
        manager.cleanup_processes().unwrap();
        manager.release_resources().unwrap();
        manager.complete(false).unwrap();
        assert!(manager.report().forced_cleanup);
        assert_eq!(manager.report().clean, Some(false));
    }
}
