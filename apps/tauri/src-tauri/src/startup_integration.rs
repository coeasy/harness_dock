//! Typed integration boundary for the first-boot startup state machine.

use tauri::{AppHandle, Manager};

use crate::{
    startup_orchestrator::StartupOrchestrator,
    AppState,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupEvent {
    SplashVisible,
    RuntimeStarting,
    RuntimeReady,
    WebRequested,
    WebReady,
    ShellAttached,
    Ready,
    Recovery,
}

pub fn apply_event(
    orchestrator: &mut StartupOrchestrator,
    event: StartupEvent,
) -> Result<(), String> {
    match event {
        StartupEvent::SplashVisible => orchestrator.mark_splash_visible(),
        StartupEvent::RuntimeStarting => orchestrator.mark_runtime_starting(),
        StartupEvent::RuntimeReady => orchestrator.mark_runtime_ready(),
        StartupEvent::WebRequested => orchestrator.mark_web_requested(),
        StartupEvent::WebReady => orchestrator.mark_web_ready(),
        StartupEvent::ShellAttached => orchestrator.mark_shell_attached(),
        StartupEvent::Ready => orchestrator.mark_ready(),
        StartupEvent::Recovery => orchestrator.mark_recovery(),
    }
}

pub(crate) fn apply_app_event(app: &AppHandle, event: StartupEvent) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut orchestrator = state
        .startup_orchestrator
        .lock()
        .map_err(|_| "StartupOrchestrator lock poisoned".to_string())?;
    apply_event(&mut orchestrator, event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::startup_orchestrator::StartupPhase;

    #[test]
    fn integration_drives_the_ordered_startup_path() {
        let mut state = StartupOrchestrator::default();
        for event in [
            StartupEvent::SplashVisible,
            StartupEvent::RuntimeStarting,
            StartupEvent::RuntimeReady,
            StartupEvent::WebRequested,
            StartupEvent::WebReady,
            StartupEvent::Ready,
        ] {
            apply_event(&mut state, event).unwrap();
        }
        assert_eq!(state.phase(), StartupPhase::Ready);
    }

    #[test]
    fn integration_rejects_skipping_runtime_readiness() {
        let mut state = StartupOrchestrator::default();
        apply_event(&mut state, StartupEvent::SplashVisible).unwrap();
        assert!(apply_event(&mut state, StartupEvent::WebRequested).is_err());
    }
}
