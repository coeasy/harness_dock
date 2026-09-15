//! Startup orchestration foundation.
//!
//! This module intentionally sits beside the existing startup coordinator during
//! migration. It separates lifecycle decisions from UI/runtime implementation so
//! future startup paths (profiles, recovery, diagnostics) can share one state
//! machine without changing RuntimeLease contracts.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StartupPhase {
    Boot,
    SplashVisible,
    RuntimeStarting,
    RuntimeReady,
    WebRequested,
    WebReady,
    ShellAttached,
    Ready,
    Recovery,
}

#[derive(Debug, Clone)]
pub struct StartupMetrics {
    started_at: Instant,
    pub runtime_ready: Option<Duration>,
    pub web_ready: Option<Duration>,
    pub finished: Option<Duration>,
}

impl Default for StartupMetrics {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            runtime_ready: None,
            web_ready: None,
            finished: None,
        }
    }
}

impl StartupMetrics {
    pub fn mark_runtime_ready(&mut self) {
        self.runtime_ready = Some(self.started_at.elapsed());
    }

    pub fn mark_web_ready(&mut self) {
        self.web_ready = Some(self.started_at.elapsed());
    }

    pub fn mark_finished(&mut self) {
        self.finished = Some(self.started_at.elapsed());
    }
}

#[derive(Debug, Clone)]
pub struct StartupOrchestrator {
    phase: StartupPhase,
    metrics: StartupMetrics,
}

impl Default for StartupOrchestrator {
    fn default() -> Self {
        Self {
            phase: StartupPhase::Boot,
            metrics: StartupMetrics::default(),
        }
    }
}

impl StartupOrchestrator {
    pub fn phase(&self) -> StartupPhase {
        self.phase
    }

    pub fn transition(&mut self, next: StartupPhase) {
        self.phase = next;
    }

    pub fn metrics(&self) -> &StartupMetrics {
        &self.metrics
    }

    pub fn metrics_mut(&mut self) -> &mut StartupMetrics {
        &mut self.metrics
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_starts_from_boot() {
        let state = StartupOrchestrator::default();
        assert_eq!(state.phase(), StartupPhase::Boot);
    }

    #[test]
    fn metrics_record_progress() {
        let mut metrics = StartupMetrics::default();
        metrics.mark_runtime_ready();
        metrics.mark_finished();
        assert!(metrics.runtime_ready.is_some());
        assert!(metrics.finished.is_some());
    }
}
