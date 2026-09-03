use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use crate::{gateway_host, process, runtime};

/// Long-lived native host state.
///
/// Keep process ownership and operation guards outside `lib.rs` so the Tauri
/// composition root does not become a second lifecycle implementation. Runtime
/// and Gateway modules own their processes; higher-level orchestration reads
/// these fields through the lifecycle/supervisor modules.
pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
    pub(crate) runtime_starting: AtomicBool,
    pub(crate) runtime_restarting: AtomicBool,
    pub(crate) runtime_stopping: AtomicBool,
    pub(crate) web_action: AtomicBool,
    pub(crate) harness_loading: AtomicBool,
    pub(crate) harness_load_generation: AtomicU64,
    pub(crate) startup_recovery_error: Mutex<Option<String>>,
    pub(crate) settings_opening: AtomicBool,
    pub(crate) gateway: Mutex<Option<gateway_host::GatewayProcess>>,
    pub(crate) gateway_starting: Arc<AtomicBool>,
    pub(crate) starting_processes: process::StartingProcessRegistry,
    pub(crate) quitting: Arc<AtomicBool>,
    pub(crate) tray_available: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            runtime_starting: AtomicBool::new(false),
            runtime_restarting: AtomicBool::new(false),
            runtime_stopping: AtomicBool::new(false),
            web_action: AtomicBool::new(false),
            harness_loading: AtomicBool::new(false),
            harness_load_generation: AtomicU64::new(0),
            startup_recovery_error: Mutex::new(None),
            settings_opening: AtomicBool::new(false),
            gateway: Mutex::new(None),
            gateway_starting: Arc::new(AtomicBool::new(false)),
            starting_processes: Arc::new(Mutex::new(std::collections::HashSet::new())),
            quitting: Arc::new(AtomicBool::new(false)),
            tray_available: AtomicBool::new(false),
        }
    }
}
