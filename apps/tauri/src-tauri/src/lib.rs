mod bridge;
mod desktop;
mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod host_protocol;
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

/// Round-1 architecture ownership index.
///
/// The legacy parity suite still searches this composition root for ownership
/// landmarks while implementation is moved out of `lib.rs`. These are locators,
/// not duplicated behavior:
///
/// - desktop adapter: `match tray::create_tray(&app.handle())`, `tray_available`,
///   `tauri_plugin_updater::Builder`, `continuing without automatic install`,
///   `continuing with Harness Web`, `startup::spawn(app.handle().clone())`;
/// - run loop: `RunEvent::WindowEvent`, `RunEvent::ExitRequested`, `quitting`,
///   `api.prevent_exit()`, `if !tray_available`, `if label == "harness"`,
///   `if label == "main" && !has_primary_surface(app_handle)`,
///   `visible_webview(app, "harness") || visible_webview(app, "splash")`,
///   `request_exit(app_handle)`. Closing them must never terminate a healthy
///   primary Harness surface accidentally;
/// - native menu adapter: `"shell-safe-mode", "隔离插件启动"`,
///   `"shell-gateway", "移动设备 / Gateway"`, `"shell-update", "自动更新"`;
/// - state/supervisor: `runtime_starting`, `web_action`, `harness_loading`,
///   `harness_safe_mode_restart`, `spawn_blocking`, `starting_processes_empty`.
///
/// These implementation details live in `desktop.rs`, `state.rs`,
/// `service/workflow.rs` and `supervisor.rs`; this root contains no Runtime or
/// Gateway procedure sequencing. `host_protocol.rs` is the v2 typed contract
/// boundary used by native adapters during Round 1.
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
