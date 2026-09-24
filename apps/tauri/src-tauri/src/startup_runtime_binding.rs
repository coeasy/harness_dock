//! Startup/runtime binding helpers.
//!
//! These helpers remain for policy tests and callers that decide a startup path
//! before owning an AppHandle. Real desktop startup uses StartupEvent through
//! startup_integration::apply_app_event.

use crate::startup_fast_path::StartupPath;
use crate::startup_integration::{apply_event, StartupEvent};
use crate::startup_orchestrator::StartupOrchestrator;

pub fn begin_runtime_start(
    orchestrator: &mut StartupOrchestrator,
    path: StartupPath,
) -> Result<(), String> {
    match path {
        StartupPath::Recovery => apply_event(orchestrator, StartupEvent::Recovery),
        StartupPath::Fast | StartupPath::Normal => {
            apply_event(orchestrator, StartupEvent::RuntimeStarting)
        }
    }
}

pub fn mark_web_requested(orchestrator: &mut StartupOrchestrator) -> Result<(), String> {
    apply_event(orchestrator, StartupEvent::WebRequested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::startup_integration::StartupEvent;
    use crate::startup_orchestrator::StartupPhase;

    #[test]
    fn runtime_binding_tracks_fast_path_after_splash() {
        let mut orchestrator = StartupOrchestrator::default();
        apply_event(&mut orchestrator, StartupEvent::SplashVisible).unwrap();
        begin_runtime_start(&mut orchestrator, StartupPath::Fast).unwrap();
        assert_eq!(orchestrator.phase(), StartupPhase::RuntimeStarting);
    }
}
