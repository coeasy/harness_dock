//! Diagnostics service adapter.
//!
//! Converts the real runtime/startup/shutdown state machines into one stable
//! snapshot. No independent diagnostic lifecycle state is maintained.

use crate::{
    diagnostic_platform::DiagnosticSnapshot, runtime_supervisor::RuntimeSupervisor,
    shutdown_manager::{ShutdownManager, ShutdownPhase},
    startup_orchestrator::StartupOrchestrator,
};

pub fn snapshot(
    runtime: &RuntimeSupervisor,
    startup: &StartupOrchestrator,
    shutdown: &ShutdownManager,
) -> DiagnosticSnapshot {
    let shutdown_report = shutdown.report();
    DiagnosticSnapshot {
        runtime_phase: format!("{:?}", runtime.state()),
        runtime_healthy: runtime.health().healthy,
        runtime_generation: runtime.health().generation,
        runtime_consecutive_failures: runtime.health().consecutive_failures,

        startup_phase: format!("{:?}", startup.phase()),
        startup_runtime_ready_ms: startup
            .metrics()
            .runtime_ready
            .map(|duration| duration.as_millis()),
        startup_web_ready_ms: startup
            .metrics()
            .web_ready
            .map(|duration| duration.as_millis()),
        startup_ms: startup
            .metrics()
            .finished
            .map(|duration| duration.as_millis()),

        shutdown_phase: format!("{:?}", shutdown.phase()),
        shutdown_complete: shutdown.phase() == ShutdownPhase::Completed,
        shutdown_duration_ms: shutdown_report.duration_ms,
        shutdown_forced_cleanup: shutdown_report.forced_cleanup,
        shutdown_clean: shutdown_report.clean,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_collects_real_lifecycle_state() {
        let mut runtime = RuntimeSupervisor::default();
        runtime.begin_start(5).unwrap();
        runtime.mark_ready(5, false).unwrap();

        let startup = StartupOrchestrator::default();
        let shutdown = ShutdownManager::default();
        let result = snapshot(&runtime, &startup, &shutdown);

        assert!(result.runtime_healthy);
        assert_eq!(result.runtime_generation, Some(5));
        assert!(!result.shutdown_complete);
    }
}
