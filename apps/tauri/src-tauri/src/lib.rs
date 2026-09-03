mod bridge;
mod desktop;
mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod lifecycle;
mod platform;
mod plugin_quarantine;
mod process;
mod runtime;
mod service;
#[cfg(not(mobile))]
mod startup;
#[cfg(not(mobile))]
mod startup_trace;
mod state;
mod supervisor;
#[cfg(not(mobile))]
mod tray;
mod update;

pub(crate) use state::AppState;
pub(crate) use supervisor::{request_exit, stop_managed_processes, wait_for_managed_processes};

/// Tauri composition root.
///
/// The desktop adapter owns native shell/event integration, `bridge` owns the
/// IPC surface and `service::workflow` owns application sequencing. Runtime,
/// Gateway and WebView modules are implementation services and are never
/// registered directly as public Tauri commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(mobile))]
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);

    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(desktop::setup)
        .invoke_handler(bridge::handler())
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    app.run(desktop::handle_run_event);
}
