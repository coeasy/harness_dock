//! Startup/runtime binding helpers for the V3 migration.
//!
//! Keeps startup.rs focused on window and WebView operations while lifecycle
//! state transitions are centralized.

use crate::startup_fast_path::StartupPath;
use crate::startup_orchestrator::{StartupOrchestrator, StartupPhase};

pub fn begin_runtime_start(orchestrator: &mut StartupOrchestrator, path: StartupPath) {
    orchestrator.transition(match path {
        StartupPath::Recovery => StartupPhase::Recovery,
        StartupPath::Fast | StartupPath::Normal => StartupPhase::RuntimeStarting,
    });
}

pub fn mark_web_requested(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::WebRequested);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_binding_tracks_fast_path() {
        let mut orchestrator = StartupOrchestrator::default();
        begin_runtime_start(&mut orchestrator, StartupPath::Fast);
        assert_eq!(orchestrator.phase(), StartupPhase::RuntimeStarting);
    }
}
