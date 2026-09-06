//! Read-only service snapshot derived from the canonical Host read model.
//!
//! The lock order and poison policy live in `read_model.rs`; this module only
//! presents the subset required by service/status readers.

use crate::lifecycle::HostPhase;
use crate::read_model::HostReadModel;
use crate::runtime_actor::RuntimePhase;
use crate::AppState;

pub(crate) struct ReadOnlySnapshot {
    pub(crate) runtime_phase: RuntimePhase,
    pub(crate) runtime_generation: Option<u64>,
    pub(crate) harness_visible: bool,
    pub(crate) gateway_enabled: bool,
}

impl ReadOnlySnapshot {
    pub(crate) fn collect(state: &AppState) -> Self {
        let model = HostReadModel::collect(state);
        let host_phase = model.host_phase();
        Self {
            runtime_phase: model.runtime_phase,
            runtime_generation: model.runtime_generation,
            // A SurfaceActor can still be physically visible for a brief
            // interval while recovery/shutdown is being reconciled. The public
            // read model reports it as usable only when the derived Host phase
            // is actually Running, preventing stale UI visibility from being
            // mistaken for lifecycle readiness.
            harness_visible: model.harness_visible && host_phase == HostPhase::Running,
            gateway_enabled: model.gateway_phase == crate::gateway_host::GatewayPhase::Ready,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_collects_without_panicking() {
        let state = AppState::default();
        let snapshot = ReadOnlySnapshot::collect(&state);
        assert_eq!(snapshot.runtime_phase, RuntimePhase::Stopped);
        assert_eq!(snapshot.runtime_generation, None);
        assert!(!snapshot.harness_visible);
        assert!(!snapshot.gateway_enabled);
    }
}
