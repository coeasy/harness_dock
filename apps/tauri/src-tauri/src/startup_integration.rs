//! Integration helpers for migrating the existing startup flow to V3.
//!
//! The current startup coordinator remains responsible for Tauri/WebView
//! operations. This module centralizes phase transitions so future migrations
//! do not duplicate lifecycle bookkeeping.

use crate::startup_orchestrator::{StartupOrchestrator, StartupPhase};

pub(crate) fn mark_runtime_starting(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::RuntimeStarting);
}

pub(crate) fn mark_runtime_ready(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::RuntimeReady);
    orchestrator.metrics_mut().mark_runtime_ready();
}

pub(crate) fn mark_web_ready(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::WebReady);
    orchestrator.metrics_mut().mark_web_ready();
}

pub(crate) fn mark_ready(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::Ready);
    orchestrator.metrics_mut().mark_finished();
}

pub(crate) fn mark_recovery(orchestrator: &mut StartupOrchestrator) {
    orchestrator.transition(StartupPhase::Recovery);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_updates_startup_phase() {
        let mut state = StartupOrchestrator::default();
        mark_runtime_starting(&mut state);
        mark_runtime_ready(&mut state);
        mark_web_ready(&mut state);
        mark_ready(&mut state);
        assert_eq!(state.phase(), StartupPhase::Ready);
    }
}
