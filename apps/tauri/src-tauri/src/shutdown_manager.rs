//! Shutdown manager foundation for Architecture V3.
//!
//! Provides an explicit shutdown state machine so UI closing can be separated
//! from asynchronous runtime and process cleanup.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone)]
pub struct ShutdownManager {
    phase: ShutdownPhase,
    force: bool,
}

impl Default for ShutdownManager {
    fn default() -> Self {
        Self {
            phase: ShutdownPhase::Running,
            force: false,
        }
    }
}

impl ShutdownManager {
    pub fn phase(&self) -> ShutdownPhase {
        self.phase
    }

    pub fn request(&mut self) {
        self.phase = ShutdownPhase::Requested;
    }

    pub fn freeze(&mut self) {
        self.phase = ShutdownPhase::Freezing;
    }

    pub fn stop_plugins(&mut self) {
        self.phase = ShutdownPhase::StoppingPlugins;
    }

    pub fn stop_runtime(&mut self) {
        self.phase = ShutdownPhase::StoppingRuntime;
    }

    pub fn cleanup_processes(&mut self) {
        self.phase = ShutdownPhase::CleaningProcesses;
    }

    pub fn release_resources(&mut self) {
        self.phase = ShutdownPhase::ReleasingResources;
    }

    pub fn complete(&mut self) {
        self.phase = ShutdownPhase::Completed;
    }

    pub fn force(&mut self) {
        self.force = true;
    }

    pub fn is_force(&self) -> bool {
        self.force
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_progresses_to_complete() {
        let mut manager = ShutdownManager::default();
        manager.request();
        manager.stop_runtime();
        manager.complete();
        assert_eq!(manager.phase(), ShutdownPhase::Completed);
    }
}
