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

pub(crate) use desktop::report_shell_error;
pub(crate) use state::AppState;
pub(crate) use supervisor::{request_exit, stop_managed_processes, wait_for_managed_processes};

/// Round-1 architecture index.
///
/// Native adapter details such as `tray::create_tray` and
/// `RunEvent::WindowEvent` live in `desktop.rs`; transition admissions such as
/// `runtime_starting`, `web_action` and `harness_loading` remain temporarily in
/// `state.rs`; `harness_safe_mode_restart` is reached through HostIntent;
/// `spawn_blocking` shutdown drain and `starting_processes_empty` convergence
/// live in `supervisor.rs`. `report_shell_error` is re-exported above for the
/// existing shell boundary while Host Protocol v2 is introduced in later
/// Round-1 commits. This composition root intentionally contains no Runtime or
/// Gateway procedure sequencing.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(mobile))]
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);

    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(desktop::setup)
        .invoke_handler(bridge::handler!())
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    app.run(desktop::handle_run_event);
}
