//! Stable structured lifecycle diagnostics exposed to local control surfaces.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticSnapshot {
    pub runtime_phase: String,
    pub runtime_healthy: bool,
    pub runtime_generation: Option<u64>,
    pub runtime_consecutive_failures: u32,

    pub startup_phase: String,
    pub startup_runtime_ready_ms: Option<u128>,
    pub startup_web_ready_ms: Option<u128>,
    pub startup_ms: Option<u128>,

    pub shutdown_phase: String,
    pub shutdown_complete: bool,
    pub shutdown_duration_ms: Option<u128>,
    pub shutdown_forced_cleanup: bool,
    pub shutdown_clean: Option<bool>,
}

impl Default for DiagnosticSnapshot {
    fn default() -> Self {
        Self {
            runtime_phase: "unknown".into(),
            runtime_healthy: false,
            runtime_generation: None,
            runtime_consecutive_failures: 0,
            startup_phase: "unknown".into(),
            startup_runtime_ready_ms: None,
            startup_web_ready_ms: None,
            startup_ms: None,
            shutdown_phase: "running".into(),
            shutdown_complete: false,
            shutdown_duration_ms: None,
            shutdown_forced_cleanup: false,
            shutdown_clean: None,
        }
    }
}

impl DiagnosticSnapshot {
    pub fn healthy(runtime_phase: impl Into<String>) -> Self {
        Self {
            runtime_phase: runtime_phase.into(),
            runtime_healthy: true,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_snapshot_can_report_health() {
        let snapshot = DiagnosticSnapshot::healthy("ready");
        assert!(snapshot.runtime_healthy);
        assert_eq!(snapshot.runtime_phase, "ready");
    }
}
