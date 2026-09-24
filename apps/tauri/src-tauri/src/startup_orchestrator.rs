//! Strict first-boot startup state machine.
//!
//! Runtime lifecycle/restarts are owned by RuntimeActor/RuntimeSupervisor.
//! This orchestrator tracks only the first application boot through the point
//! where the primary Harness surface becomes usable. Once Ready, later Runtime
//! restarts/reloads do not rewrite startup metrics.

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
    fn mark_runtime_ready(&mut self) {
        self.runtime_ready = Some(self.started_at.elapsed());
    }

    fn mark_web_ready(&mut self) {
        self.web_ready = Some(self.started_at.elapsed());
    }

    fn mark_finished(&mut self) {
        if self.finished.is_none() {
            self.finished = Some(self.started_at.elapsed());
        }
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

    pub fn metrics(&self) -> &StartupMetrics {
        &self.metrics
    }

    pub fn is_complete(&self) -> bool {
        self.phase == StartupPhase::Ready
    }

    fn transition(&mut self, next: StartupPhase) -> Result<(), String> {
        if self.phase == next {
            return Ok(());
        }
        if self.is_complete() {
            // Startup is a first-boot metric/state machine. Runtime restarts,
            // refreshes and later recovery UI must not rewrite it.
            return Ok(());
        }

        let valid = matches!(
            (self.phase, next),
            (StartupPhase::Boot, StartupPhase::SplashVisible)
                | (StartupPhase::SplashVisible, StartupPhase::RuntimeStarting)
                | (StartupPhase::RuntimeStarting, StartupPhase::RuntimeReady)
                | (StartupPhase::RuntimeReady, StartupPhase::WebRequested)
                | (StartupPhase::WebRequested, StartupPhase::WebReady)
                | (StartupPhase::WebReady, StartupPhase::ShellAttached)
                | (StartupPhase::WebReady, StartupPhase::Ready)
                | (StartupPhase::ShellAttached, StartupPhase::Ready)
                | (StartupPhase::Recovery, StartupPhase::RuntimeStarting)
        ) || (next == StartupPhase::Recovery && self.phase != StartupPhase::Ready);

        if !valid {
            return Err(format!(
                "invalid startup transition: {:?} -> {:?}",
                self.phase, next
            ));
        }

        self.phase = next;
        match next {
            StartupPhase::RuntimeReady => self.metrics.mark_runtime_ready(),
            StartupPhase::WebReady => self.metrics.mark_web_ready(),
            StartupPhase::Ready => self.metrics.mark_finished(),
            _ => {}
        }
        Ok(())
    }

    pub fn mark_splash_visible(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::SplashVisible)
    }

    pub fn mark_runtime_starting(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::RuntimeStarting)
    }

    pub fn mark_runtime_ready(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::RuntimeReady)
    }

    pub fn mark_web_requested(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::WebRequested)
    }

    pub fn mark_web_ready(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::WebReady)
    }

    pub fn mark_shell_attached(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::ShellAttached)
    }

    pub fn mark_ready(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::Ready)
    }

    pub fn mark_recovery(&mut self) -> Result<(), String> {
        self.transition(StartupPhase::Recovery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_startup_requires_ordered_transitions() {
        let mut state = StartupOrchestrator::default();
        state.mark_splash_visible().unwrap();
        state.mark_runtime_starting().unwrap();
        state.mark_runtime_ready().unwrap();
        state.mark_web_requested().unwrap();
        state.mark_web_ready().unwrap();
        state.mark_shell_attached().unwrap();
        state.mark_ready().unwrap();

        assert_eq!(state.phase(), StartupPhase::Ready);
        assert!(state.metrics().runtime_ready.is_some());
        assert!(state.metrics().web_ready.is_some());
        assert!(state.metrics().finished.is_some());
    }

    #[test]
    fn invalid_transition_is_rejected() {
        let mut state = StartupOrchestrator::default();
        assert!(state.mark_ready().is_err());
        assert_eq!(state.phase(), StartupPhase::Boot);
    }

    #[test]
    fn recovery_can_retry_but_ready_is_terminal_for_startup_metrics() {
        let mut state = StartupOrchestrator::default();
        state.mark_recovery().unwrap();
        state.mark_runtime_starting().unwrap();
        state.mark_runtime_ready().unwrap();
        state.mark_web_requested().unwrap();
        state.mark_web_ready().unwrap();
        state.mark_ready().unwrap();
        let finished = state.metrics().finished;

        state.mark_recovery().unwrap();
        state.mark_runtime_starting().unwrap();
        assert_eq!(state.phase(), StartupPhase::Ready);
        assert_eq!(state.metrics().finished, finished);
    }
}
