use std::sync::atomic::Ordering;

use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeOperation {
    Idle,
    Starting,
    Restarting,
    Stopping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GatewayOperation {
    Idle,
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebOperation {
    Idle,
    Action,
    Loading,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostLifecycleSnapshot {
    pub(crate) runtime: RuntimeOperation,
    pub(crate) gateway: GatewayOperation,
    pub(crate) web: WebOperation,
    pub(crate) quitting: bool,
    pub(crate) recovery_pending: bool,
    pub(crate) tray_available: bool,
    pub(crate) harness_generation: u64,
    pub(crate) violations: Vec<&'static str>,
}

impl HostLifecycleSnapshot {
    /// Managed child shutdown is complete only when every lifecycle admission
    /// has returned to idle. A restart intentionally overlaps its internal
    /// stop/start sub-phases, so it is represented as one typed operation here.
    pub(crate) fn managed_operations_idle(&self) -> bool {
        matches!(self.runtime, RuntimeOperation::Idle)
            && matches!(self.gateway, GatewayOperation::Idle)
    }
}

/// Normalize the host's low-level admission flags into one typed read model.
///
/// The existing Runtime/Gateway modules remain the transition owners; this
/// layer gives the composition root and shutdown supervisor one canonical view
/// instead of re-implementing precedence rules in multiple places.
pub(crate) fn snapshot(state: &AppState) -> HostLifecycleSnapshot {
    let starting = state.runtime_starting.load(Ordering::Acquire);
    let restarting = state.runtime_restarting.load(Ordering::Acquire);
    let stopping = state.runtime_stopping.load(Ordering::Acquire);
    let gateway_busy = state.gateway_starting.load(Ordering::Acquire);
    let web_action = state.web_action.load(Ordering::Acquire);
    let loading = state.harness_loading.load(Ordering::Acquire);

    let runtime = if restarting {
        RuntimeOperation::Restarting
    } else if stopping {
        RuntimeOperation::Stopping
    } else if starting {
        RuntimeOperation::Starting
    } else {
        RuntimeOperation::Idle
    };
    let gateway = if gateway_busy {
        GatewayOperation::Busy
    } else {
        GatewayOperation::Idle
    };
    let web = if loading {
        WebOperation::Loading
    } else if web_action {
        WebOperation::Action
    } else {
        WebOperation::Idle
    };

    let mut violations = Vec::new();
    // Restart owns its nested stop/start phases, therefore their overlap is
    // expected only while the restart admission bit is active.
    if starting && stopping && !restarting {
        violations.push("runtime-start-stop-overlap");
    }
    if gateway_busy && (restarting || stopping) {
        violations.push("gateway-runtime-transition-overlap");
    }

    HostLifecycleSnapshot {
        runtime,
        gateway,
        web,
        quitting: state.quitting.load(Ordering::Acquire),
        recovery_pending: state
            .startup_recovery_error
            .lock()
            .map(|error| error.is_some())
            .unwrap_or(true),
        tray_available: state.tray_available.load(Ordering::Acquire),
        harness_generation: state.harness_load_generation.load(Ordering::Acquire),
        violations,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;

    #[test]
    fn restart_collapses_nested_stop_and_start_into_one_phase() {
        let state = AppState::default();
        state.runtime_restarting.store(true, Ordering::Release);
        state.runtime_starting.store(true, Ordering::Release);
        state.runtime_stopping.store(true, Ordering::Release);

        let current = snapshot(&state);
        assert_eq!(current.runtime, RuntimeOperation::Restarting);
        assert!(current.violations.is_empty());
    }

    #[test]
    fn impossible_start_stop_overlap_is_visible_to_diagnostics() {
        let state = AppState::default();
        state.runtime_starting.store(true, Ordering::Release);
        state.runtime_stopping.store(true, Ordering::Release);

        let current = snapshot(&state);
        assert_eq!(current.runtime, RuntimeOperation::Stopping);
        assert_eq!(current.violations, vec!["runtime-start-stop-overlap"]);
    }

    #[test]
    fn web_loading_has_precedence_over_action_admission() {
        let state = AppState::default();
        state.web_action.store(true, Ordering::Release);
        state.harness_loading.store(true, Ordering::Release);
        assert_eq!(snapshot(&state).web, WebOperation::Loading);
    }
}
