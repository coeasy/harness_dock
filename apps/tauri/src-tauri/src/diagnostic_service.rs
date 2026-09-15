//! Diagnostics service adapter.
//!
//! Converts internal lifecycle actors into a stable diagnostic snapshot.

use crate::{
    diagnostic_platform::DiagnosticSnapshot, runtime_supervisor::RuntimeSupervisor,
    shutdown_manager::ShutdownManager, startup_orchestrator::StartupOrchestrator,
};

pub fn snapshot(
    runtime: &RuntimeSupervisor,
    startup: &StartupOrchestrator,
    shutdown: &ShutdownManager,
) -> DiagnosticSnapshot {
    DiagnosticSnapshot {
        runtime_phase: format!("{:?}", runtime.state()),
        startup_phase: format!("{:?}", startup.phase()),
        shutdown_phase: format!("{:?}", shutdown.phase()),
        runtime_healthy: runtime.health().healthy,
        startup_ms: startup
            .metrics()
            .finished
            .map(|duration| duration.as_millis()),
        shutdown_complete: format!("{:?}", shutdown.phase()) == "Completed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_collects_platform_state() {
        let runtime = RuntimeSupervisor::default();
        let startup = StartupOrchestrator::default();
        let shutdown = ShutdownManager::default();
        let result = snapshot(&runtime, &startup, &shutdown);
        assert!(!result.runtime_healthy);
    }
}
