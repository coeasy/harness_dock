use crate::{
    gateway_host::GatewayPhase,
    read_model::HostReadModel,
    runtime_actor::RuntimePhase,
    surface_actor::SurfaceOperation,
    update_actor::UpdatePhase,
    AppState,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct LifecycleSnapshot {
    pub runtime_phase: RuntimePhase,
    pub gateway_phase: GatewayPhase,
    pub update_phase: UpdatePhase,
    pub surface_operation: SurfaceOperation,
}

impl LifecycleSnapshot {
    pub(crate) fn managed_operations_idle(&self) -> bool {
        !matches!(
            self.runtime_phase,
            RuntimePhase::Preparing
                | RuntimePhase::Starting
                | RuntimePhase::Probing
                | RuntimePhase::Stopping
                | RuntimePhase::Cancelling
        ) && !matches!(
            self.gateway_phase,
            GatewayPhase::Starting | GatewayPhase::Stopping
        ) && matches!(
            self.update_phase,
            UpdatePhase::Idle | UpdatePhase::Failed | UpdatePhase::Restarting
        ) && self.surface_operation == SurfaceOperation::Idle
    }
}

pub(crate) fn snapshot(state: &AppState) -> LifecycleSnapshot {
    let model = HostReadModel::collect(state);
    LifecycleSnapshot {
        runtime_phase: model.runtime_phase,
        gateway_phase: model.gateway_phase,
        update_phase: model.update_phase,
        surface_operation: model.surface_operation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_actor_states_define_shutdown_idleness() {
        let idle = LifecycleSnapshot {
            runtime_phase: RuntimePhase::Ready,
            gateway_phase: GatewayPhase::Ready,
            update_phase: UpdatePhase::Idle,
            surface_operation: SurfaceOperation::Idle,
        };
        assert!(idle.managed_operations_idle());
        assert!(LifecycleSnapshot {
            update_phase: UpdatePhase::Restarting,
            ..idle
        }
        .managed_operations_idle());
        assert!(!LifecycleSnapshot {
            runtime_phase: RuntimePhase::Cancelling,
            ..idle
        }
        .managed_operations_idle());
    }
}
