//! Single read-only state access layer.
//!
//! Status readers used to spread direct `Mutex<Actor>` locks across `bridge.rs`
//! with an ad-hoc ordering, which makes the lock order easy to break by adding
//! a new reader later. `ReadOnlySnapshot` centralizes the read path and
//! documents the canonical lock order:
//!
//!   1. `runtime_actor`
//!   2. `surface_actor`
//!   3. `gateway`
//!   4. `update_actor`
//!
//! Nothing in this module mutates actor state: it is the read-only counterpart
//! of the Host Kernel / Reconciler mutation path.

use crate::runtime_actor::{RuntimeLease, RuntimePhase};
use crate::AppState;

pub(crate) struct ReadOnlySnapshot {
    pub(crate) runtime_phase: RuntimePhase,
    pub(crate) runtime_generation: Option<u64>,
    pub(crate) runtime_lease: Option<RuntimeLease>,
    pub(crate) harness_visible: bool,
    pub(crate) gateway_enabled: bool,
}

impl ReadOnlySnapshot {
    /// Collect the current state of all actors without mutating any of them.
    ///
    /// Lock ordering is intentionally the same everywhere this module is used
    /// (runtime -> surface -> gateway). Never reorder these locks in a new
    /// reader; add the new state to this snapshot instead.
    pub(crate) fn collect(state: &AppState) -> Self {
        let (runtime_phase, runtime_generation, runtime_lease) = {
            let actor = match state.runtime_actor.lock() {
                Ok(actor) => actor,
                Err(poisoned) => poisoned.into_inner(),
            };
            (
                actor.phase(),
                actor.generation_id(),
                actor.lease(),
            )
        };
        let harness_visible = state
            .surface_actor
            .lock()
            .map(|actor| actor.primary_visible())
            .unwrap_or(false);
        let gateway_enabled = state
            .gateway
            .lock()
            .map(|actor| actor.phase() == crate::gateway_host::GatewayPhase::Ready)
            .unwrap_or(false);
        Self {
            runtime_phase,
            runtime_generation,
            runtime_lease,
            harness_visible,
            gateway_enabled,
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
        assert!(snapshot.runtime_lease.is_none());
        assert!(!snapshot.harness_visible);
        assert!(!snapshot.gateway_enabled);
    }
}