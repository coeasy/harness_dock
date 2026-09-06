//! Canonical read-only projection across Native Host actors.
//!
//! Every cross-actor reader goes through this collector so adding a field does
//! not create another hand-maintained lock order. Guards are deliberately
//! short-lived and never nested; mutation remains owned by the Host Kernel /
//! Reconciler path.

use crate::{
    gateway_host::GatewayPhase,
    runtime_actor::{RuntimeLease, RuntimePhase},
    surface_actor::SurfaceOperation,
    update_actor::UpdatePhase,
    AppState,
};

#[derive(Clone)]
pub(crate) struct HostReadModel {
    pub(crate) runtime_phase: RuntimePhase,
    pub(crate) runtime_generation: Option<u64>,
    pub(crate) runtime_lease: Option<RuntimeLease>,
    pub(crate) surface_operation: SurfaceOperation,
    pub(crate) harness_visible: bool,
    pub(crate) gateway_phase: GatewayPhase,
    pub(crate) update_phase: UpdatePhase,
}

impl HostReadModel {
    pub(crate) fn collect(state: &AppState) -> Self {
        // Canonical read order: runtime -> surface -> gateway -> update.
        let (runtime_phase, runtime_generation, runtime_lease) = state
            .runtime_actor
            .lock()
            .map(|actor| (actor.phase(), actor.generation_id(), actor.lease()))
            .unwrap_or((RuntimePhase::Failed, None, None));

        let (surface_operation, harness_visible) = state
            .surface_actor
            .lock()
            .map(|actor| (actor.operation(), actor.primary_visible()))
            .unwrap_or((SurfaceOperation::Idle, false));

        let gateway_phase = state
            .gateway
            .lock()
            .map(|actor| actor.phase())
            .unwrap_or(GatewayPhase::Failed);

        let update_phase = state
            .update_actor
            .lock()
            .map(|actor| actor.phase())
            .unwrap_or(UpdatePhase::Failed);

        Self {
            runtime_phase,
            runtime_generation,
            runtime_lease,
            surface_operation,
            harness_visible,
            gateway_phase,
            update_phase,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_projects_all_actor_defaults() {
        let model = HostReadModel::collect(&AppState::default());
        assert_eq!(model.runtime_phase, RuntimePhase::Stopped);
        assert_eq!(model.runtime_generation, None);
        assert!(model.runtime_lease.is_none());
        assert_eq!(model.surface_operation, SurfaceOperation::Idle);
        assert!(!model.harness_visible);
        assert_eq!(model.gateway_phase, GatewayPhase::Stopped);
        assert_eq!(model.update_phase, UpdatePhase::Idle);
    }
}
