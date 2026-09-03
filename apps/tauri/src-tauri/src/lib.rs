#[cfg(not(mobile))]
#[macro_use]
mod bridge;
#[cfg(not(mobile))]
mod capability_broker;
#[cfg(not(mobile))]
mod desktop;
mod gateway;
#[cfg(not(mobile))]
mod gateway_host;
#[cfg(not(mobile))]
mod harness_shell;
#[cfg(not(mobile))]
mod harness_window;
#[cfg(not(mobile))]
mod host_kernel;
#[cfg(not(mobile))]
mod host_protocol;
#[cfg(not(mobile))]
mod lifecycle;
mod platform;
#[cfg(not(mobile))]
mod plugin_quarantine;
#[cfg(not(mobile))]
mod process;
#[cfg(not(mobile))]
mod reconciler;
#[cfg(not(mobile))]
mod runtime;
#[cfg(not(mobile))]
mod runtime_actor;
#[cfg(not(mobile))]
mod service;
#[cfg(not(mobile))]
mod single_instance;
#[cfg(not(mobile))]
mod startup;
#[cfg(not(mobile))]
mod startup_trace;
#[cfg(not(mobile))]
mod state;
#[cfg(not(mobile))]
mod supervisor;
#[cfg(not(mobile))]
mod surface_actor;
#[cfg(not(mobile))]
mod tray;
#[cfg(not(mobile))]
mod update;
#[cfg(not(mobile))]
mod update_actor;

#[cfg(not(mobile))]
use tauri::Manager as _;

#[cfg(not(mobile))]
pub(crate) use state::AppState;
#[cfg(not(mobile))]
pub(crate) use supervisor::{request_exit, stop_managed_processes, wait_for_managed_processes};

/// Desktop is the Native Host: it owns Runtime, Gateway Host, updates, plugins,
/// tray/menu surfaces and the single-writer Host Kernel.
#[cfg(not(mobile))]
pub fn run() {
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            host_kernel::install(app.handle().clone()).map_err(std::io::Error::other)?;
            match single_instance::install(app.handle().clone()).map_err(std::io::Error::other)? {
                single_instance::InstallOutcome::Primary(guard) => {
                    *app.state::<AppState>()
                        .single_instance
                        .lock()
                        .map_err(|_| std::io::Error::other("single-instance state lock poisoned"))? = Some(guard);
                }
                single_instance::InstallOutcome::SecondaryHandedOff => {
                    app.handle().exit(0);
                    return Ok(());
                }
            }
            desktop::setup(app)
        })
        .invoke_handler(bridge::handler!())
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock")
        .run(desktop::handle_run_event);
}

/// Mobile is deliberately a Thin Remote Client. It never owns or starts the
/// local Harness Runtime, Host Kernel, plugin/update actors, tray/menu or local
/// Gateway Host. Its native surface only validates/reaches a remote Gateway and
/// performs the one-time pairing bootstrap.
#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            platform::platform_info,
            gateway::gateway_health,
            gateway::pair_gateway
        ])
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock mobile client")
        .run(|_, _| {});
}
