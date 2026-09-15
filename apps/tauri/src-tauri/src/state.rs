use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use crate::{
    gateway_host, host_kernel, performance_metrics, process, runtime_actor, runtime_supervisor,
    shutdown_manager, startup_orchestrator, surface_actor, update_actor,
};

pub(crate) struct AppState {
    pub(crate) runtime_actor: Mutex<runtime_actor::RuntimeActor>,
    pub(crate) runtime_supervisor: Mutex<runtime_supervisor::RuntimeSupervisor>,
    pub(crate) startup_orchestrator: Mutex<startup_orchestrator::StartupOrchestrator>,
    pub(crate) shutdown_manager: Mutex<shutdown_manager::ShutdownManager>,
    pub(crate) performance_metrics: Mutex<performance_metrics::PerformanceMetrics>,
    pub(crate) surface_actor: Mutex<surface_actor::SurfaceActorState>,
    pub(crate) gateway: Mutex<gateway_host::GatewayActorState>,
    pub(crate) update_actor: Mutex<update_actor::UpdateActorState>,
    pub(crate) revision: AtomicU64,
    pub(crate) host_kernel: Mutex<Option<host_kernel::HostKernelHandle>>,
    pub(crate) startup_recovery_error: Mutex<Option<String>>,
    pub(crate) client_plugin_failures: Mutex<Vec<String>>,
    pub(crate) starting_processes: process::StartingProcessRegistry,
    pub(crate) quitting: Arc<AtomicBool>,
    pub(crate) tray_available: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime_actor: Mutex::new(runtime_actor::RuntimeActor::default()),
            runtime_supervisor: Mutex::new(runtime_supervisor::RuntimeSupervisor::default()),
            startup_orchestrator: Mutex::new(startup_orchestrator::StartupOrchestrator::default()),
            shutdown_manager: Mutex::new(shutdown_manager::ShutdownManager::default()),
            performance_metrics: Mutex::new(performance_metrics::PerformanceMetrics::default()),
            surface_actor: Mutex::new(surface_actor::SurfaceActorState::default()),
            gateway: Mutex::new(gateway_host::GatewayActorState::default()),
            update_actor: Mutex::new(update_actor::UpdateActorState::default()),
            revision: AtomicU64::new(0),
            host_kernel: Mutex::new(None),
            startup_recovery_error: Mutex::new(None),
            client_plugin_failures: Mutex::new(Vec::new()),
            starting_processes: Arc::new(Mutex::new(std::collections::HashSet::new())),
            quitting: Arc::new(AtomicBool::new(false)),
            tray_available: AtomicBool::new(false),
        }
    }
}
