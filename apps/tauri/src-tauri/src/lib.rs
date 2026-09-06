#[cfg(not(mobile))]
#[macro_use]
mod bridge;
#[cfg(not(mobile))]
mod capability_broker;
#[cfg(not(mobile))]
mod constants;
mod crypto;
#[cfg(not(mobile))]
mod desktop;
#[cfg(not(mobile))]
mod diagnostic;
#[cfg(not(mobile))]
mod error;
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
mod lease;
#[cfg(not(mobile))]
mod lifecycle;
#[cfg(mobile)]
mod mobile;
mod platform;
#[cfg(not(mobile))]
mod plugin_quarantine;
#[cfg(not(mobile))]
mod process;
#[cfg(not(mobile))]
mod read_model;
#[cfg(not(mobile))]
mod reconciler;
#[cfg(not(mobile))]
mod runtime;
#[cfg(not(mobile))]
mod runtime_actor;
#[cfg(not(mobile))]
mod runtime_ready_contract_generated;
#[cfg(not(mobile))]
mod service;
#[cfg(not(mobile))]
mod shell_contract_generated;
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
mod util;

#[cfg(not(mobile))]
pub(crate) use state::AppState;
#[cfg(not(mobile))]
pub(crate) use supervisor::{request_exit, stop_managed_processes, wait_for_managed_processes};

#[cfg(not(mobile))]
pub fn run() {
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            single_instance::handle_secondary_launch(app.clone());
        }))
        .manage(AppState::default())
        .setup(desktop::setup)
        .invoke_handler(bridge::handler!())
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock");

    app.run(desktop::handle_run_event);
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(mobile::setup)
        .invoke_handler(tauri::generate_handler![
            platform::platform_info,
            gateway::gateway_health,
            gateway::pair_gateway
        ])
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock mobile");

    app.run(mobile::handle_run_event);
}
