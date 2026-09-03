use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::{
    gateway_host, host_kernel, process, reconciler, runtime_actor, surface_actor, update_actor,
};

pub(crate) struct AppState {
    pub(crate) runtime_actor: Mutex<runtime_actor::RuntimeActor>,
    pub(crate) surface_actor: Mutex<surface_actor::SurfaceActorState>,
    pub(crate) gateway: Mutex<gateway_host::GatewayActorState>,
    pub(crate) update_actor: Mutex<update_actor::UpdateActorState>,
    pub(crate) desired: Mutex<reconciler::HostDesiredState>,
    pub(crate) host_kernel: Mutex<Option<host_kernel::HostKernelHandle>>,
    pub(crate) startup_recovery_error: Mutex<Option<String>>,
    pub(crate) starting_processes: process::StartingProcessRegistry,
    pub(crate) quitting: Arc<AtomicBool>,
    pub(crate) tray_available: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime_actor: Mutex::new(runtime_actor::RuntimeActor::default()),
            surface_actor: Mutex::new(surface_actor::SurfaceActorState::default()),
            gateway: Mutex::new(gateway_host::GatewayActorState::default()),
            update_actor: Mutex::new(update_actor::UpdateActorState::default()),
            desired: Mutex::new(reconciler::HostDesiredState::default()),
            host_kernel: Mutex::new(None),
            startup_recovery_error: Mutex::new(None),
            starting_processes: Arc::new(Mutex::new(std::collections::HashSet::new())),
            quitting: Arc::new(AtomicBool::new(false)),
            tray_available: AtomicBool::new(false),
        }
    }
}
