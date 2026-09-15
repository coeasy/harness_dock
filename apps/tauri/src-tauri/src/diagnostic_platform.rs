//! Diagnostics platform foundation.
//!
//! Provides a single structured view over runtime, startup, shutdown and
//! application health information.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticSnapshot {
    pub runtime_phase: String,
    pub startup_phase: String,
    pub shutdown_phase: String,
    pub runtime_healthy: bool,
    pub startup_ms: Option<u128>,
    pub shutdown_complete: bool,
}

impl Default for DiagnosticSnapshot {
    fn default() -> Self {
        Self {
            runtime_phase: "unknown".into(),
            startup_phase: "unknown".into(),
            shutdown_phase: "running".into(),
            runtime_healthy: false,
            startup_ms: None,
            shutdown_complete: false,
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
