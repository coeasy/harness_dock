#[macro_use]
mod bridge;
mod capability_broker;
#[cfg(not(mobile))]
mod desktop;
mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod host_kernel;
mod host_protocol;
mod lifecycle;
#[cfg(mobile)]
mod mobile;
mod platform;
mod plugin_quarantine;
mod process;
mod reconciler;
mod runtime;
mod runtime_actor;
mod service;
#[cfg(not(mobile))]
mod single_instance;
#[cfg(not(mobile))]
mod startup;
mod startup_trace;
mod state;
mod supervisor;
mod surface_actor;
#[cfg(not(mobile))]
mod tray;
mod update;
mod update_actor;

#[cfg(not(mobile))]
use desktop as native_adapter;
#[cfg(mobile)]
use mobile as native_adapter;
use tauri::Manager as _;

pub(crate) use state::AppState;
pub(crate) use supervisor::request_exit;
#[cfg(not(mobile))]
pub(crate) use supervisor::{stop_managed_processes, wait_for_managed_processes};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);

    let builder = tauri::Builder::default();
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        single_instance::handle_secondary_launch(app.clone());
    }));

    builder
        .manage(AppState::default())
        .setup(|app| {
            host_kernel::install(app.handle().clone()).map_err(std::io::Error::other)?;
            native_adapter::setup(app)
        })
        .invoke_handler(bridge::handler!())
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock")
        .run(native_adapter::handle_run_event);
}
