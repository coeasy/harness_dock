//! Shutdown integration layer for Architecture V3.
//!
//! Keeps existing process ownership in supervisor/process modules while moving
//! shutdown policy decisions into ShutdownManager.

use crate::shutdown_manager::{ShutdownManager, ShutdownPhase};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownEvent {
    Request,
    Freeze,
    PluginsStopped,
    RuntimeStopped,
    ProcessesCleaned,
    ResourcesReleased,
    Completed,
}

pub fn apply_event(manager: &mut ShutdownManager, event: ShutdownEvent) {
    match event {
        ShutdownEvent::Request => manager.request(),
        ShutdownEvent::Freeze => manager.freeze(),
        ShutdownEvent::PluginsStopped => manager.stop_plugins(),
        ShutdownEvent::RuntimeStopped => manager.stop_runtime(),
        ShutdownEvent::ProcessesCleaned => manager.cleanup_processes(),
        ShutdownEvent::ResourcesReleased => manager.release_resources(),
        ShutdownEvent::Completed => manager.complete(),
    }
}

pub fn should_force_exit(manager: &ShutdownManager) -> bool {
    manager.is_force() || manager.phase() == ShutdownPhase::CleaningProcesses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_event_flow_reaches_completion() {
        let mut manager = ShutdownManager::default();
        apply_event(&mut manager, ShutdownEvent::Request);
        apply_event(&mut manager, ShutdownEvent::RuntimeStopped);
        apply_event(&mut manager, ShutdownEvent::Completed);
        assert_eq!(manager.phase(), ShutdownPhase::Completed);
    }
}
