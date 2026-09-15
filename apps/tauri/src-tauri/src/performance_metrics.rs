//! Performance metrics foundation for startup/shutdown observability.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerformanceSnapshot {
    pub runtime_ready_ms: Option<u128>,
    pub web_ready_ms: Option<u128>,
    pub shutdown_ms: Option<u128>,
}

#[derive(Debug)]
pub struct PerformanceMetrics {
    started: Instant,
    snapshot: PerformanceSnapshot,
}

impl Default for PerformanceMetrics {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            snapshot: PerformanceSnapshot::default(),
        }
    }
}

impl PerformanceMetrics {
    pub fn mark_runtime_ready(&mut self) {
        self.snapshot.runtime_ready_ms = Some(self.started.elapsed().as_millis());
    }

    pub fn mark_web_ready(&mut self) {
        self.snapshot.web_ready_ms = Some(self.started.elapsed().as_millis());
    }

    pub fn mark_shutdown(&mut self, duration: Duration) {
        self.snapshot.shutdown_ms = Some(duration.as_millis());
    }

    pub fn snapshot(&self) -> &PerformanceSnapshot {
        &self.snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_runtime_ready() {
        let mut metrics = PerformanceMetrics::default();
        metrics.mark_runtime_ready();
        assert!(metrics.snapshot().runtime_ready_ms.is_some());
    }
}
