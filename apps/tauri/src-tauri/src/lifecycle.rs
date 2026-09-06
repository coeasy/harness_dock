use serde::{Deserialize, Serialize};

use crate::{
    gateway_host::GatewayPhase,
    read_model::HostReadModel,
    runtime_actor::RuntimePhase,
    surface_actor::{SurfaceOperation, SurfacePhase},
    update_actor::UpdatePhase,
    AppState,
};

/// Canonical high-level Host lifecycle. This is deliberately a projection of
/// Resource Actor state rather than another mutable state machine: Runtime,
/// Surface, Gateway and Update actors remain the only lifecycle truth sources.
/// The Host Kernel can therefore expose one stable phase without creating a
/// second set of transitions that can drift from the resources it coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HostPhase {
    #[default]
    Booting,
    RuntimeStarting,
    RuntimeReady,
    WebLoading,
    Running,
    Recovering,
    ShuttingDown,
}

pub(crate) fn derive_host_phase(model: &HostReadModel) -> HostPhase {
    if model.quitting {
        return HostPhase::ShuttingDown;
    }
    if model.recovery_pending
        || model.runtime_phase == RuntimePhase::Failed
        || model.surface_phase == SurfacePhase::Failed
        || model.update_phase == UpdatePhase::Failed
    {
        return HostPhase::Recovering;
    }

    match model.runtime_phase {
        RuntimePhase::Stopped if model.runtime_generation.is_none() => HostPhase::Booting,
        RuntimePhase::Preparing | RuntimePhase::Starting | RuntimePhase::Probing => {
            HostPhase::RuntimeStarting
        }
        RuntimePhase::Stopping | RuntimePhase::Cancelling => HostPhase::Recovering,
        RuntimePhase::Ready | RuntimePhase::Degraded => {
            if model.harness_visible {
                HostPhase::Running
            } else if model.surface_phase == SurfacePhase::Loading {
                HostPhase::WebLoading
            } else {
                HostPhase::RuntimeReady
            }
        }
        RuntimePhase::Stopped | RuntimePhase::Failed => HostPhase::Recovering,
    }
}

/// Minimal shutdown projection. High-level `HostPhase` is exposed through the
/// Host Protocol read model; the supervisor only needs actor operation state
/// to decide when managed resources have drained.
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

    fn model(runtime_phase: RuntimePhase, surface_phase: SurfacePhase) -> HostReadModel {
        HostReadModel {
            runtime_phase,
            runtime_generation: if runtime_phase == RuntimePhase::Stopped {
                None
            } else {
                Some(1)
            },
            surface_phase,
            surface_operation: SurfaceOperation::Idle,
            harness_visible: false,
            gateway_phase: GatewayPhase::Stopped,
            update_phase: UpdatePhase::Idle,
            recovery_pending: false,
            quitting: false,
        }
    }

    #[test]
    fn actor_projection_forms_the_webfirst_host_lifecycle() {
        assert_eq!(
            derive_host_phase(&model(RuntimePhase::Stopped, SurfacePhase::Hidden)),
            HostPhase::Booting
        );
        assert_eq!(
            derive_host_phase(&model(RuntimePhase::Starting, SurfacePhase::Hidden)),
            HostPhase::RuntimeStarting
        );
        assert_eq!(
            derive_host_phase(&model(RuntimePhase::Ready, SurfacePhase::Hidden)),
            HostPhase::RuntimeReady
        );
        assert_eq!(
            derive_host_phase(&model(RuntimePhase::Ready, SurfacePhase::Loading)),
            HostPhase::WebLoading
        );
        let mut running = model(RuntimePhase::Ready, SurfacePhase::Visible);
        running.harness_visible = true;
        assert_eq!(derive_host_phase(&running), HostPhase::Running);
    }

    #[test]
    fn recovery_and_shutdown_override_resource_detail() {
        let mut current = model(RuntimePhase::Ready, SurfacePhase::Visible);
        current.harness_visible = true;
        current.recovery_pending = true;
        assert_eq!(derive_host_phase(&current), HostPhase::Recovering);
        current.quitting = true;
        assert_eq!(derive_host_phase(&current), HostPhase::ShuttingDown);
    }

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
