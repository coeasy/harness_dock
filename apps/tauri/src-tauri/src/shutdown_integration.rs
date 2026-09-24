//! Typed integration boundary for shutdown state and diagnostics.

use tauri::{AppHandle, Manager};

use crate::{
    shutdown_manager::{ShutdownManager, ShutdownPhase},
    AppState,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownEvent {
    Request,
    Freeze,
    StopPlugins,
    StopRuntime,
    CleanupProcesses,
    ReleaseResources,
    Complete { clean: bool },
    ForceCleanup,
}

pub fn apply_event(
    manager: &mut ShutdownManager,
    event: ShutdownEvent,
) -> Result<(), String> {
    match event {
        ShutdownEvent::Request => manager.request(),
        ShutdownEvent::Freeze => manager.freeze(),
        ShutdownEvent::StopPlugins => manager.stop_plugins(),
        ShutdownEvent::StopRuntime => manager.stop_runtime(),
        ShutdownEvent::CleanupProcesses => manager.cleanup_processes(),
        ShutdownEvent::ReleaseResources => manager.release_resources(),
        ShutdownEvent::Complete { clean } => manager.complete(clean),
        ShutdownEvent::ForceCleanup => {
            manager.force();
            Ok(())
        }
    }
}

pub(crate) fn apply_app_event(app: &AppHandle, event: ShutdownEvent) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut manager = state
        .shutdown_manager
        .lock()
        .map_err(|_| "ShutdownManager lock poisoned".to_string())?;
    apply_event(&mut manager, event)
}

pub fn should_force_exit(manager: &ShutdownManager) -> bool {
    manager.is_force() || manager.phase() == ShutdownPhase::CleaningProcesses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_reaches_clean_completion() {
        let mut manager = ShutdownManager::default();
        for event in [
            ShutdownEvent::Request,
            ShutdownEvent::Freeze,
            ShutdownEvent::StopPlugins,
            ShutdownEvent::StopRuntime,
            ShutdownEvent::CleanupProcesses,
            ShutdownEvent::ReleaseResources,
            ShutdownEvent::Complete { clean: true },
        ] {
            apply_event(&mut manager, event).unwrap();
        }
        assert_eq!(manager.phase(), ShutdownPhase::Completed);
        assert_eq!(manager.report().clean, Some(true));
    }
}
