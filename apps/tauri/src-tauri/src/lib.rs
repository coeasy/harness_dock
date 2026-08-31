mod gateway;
mod gateway_host;
mod harness_window;
mod platform;
mod plugin_quarantine;
mod runtime;

use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
    pub(crate) gateway: Mutex<Option<gateway_host::GatewayProcess>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            platform::platform_info,
            gateway::gateway_health,
            gateway::pair_gateway,
            gateway_host::gateway_host_status,
            gateway_host::gateway_host_start,
            gateway_host::gateway_host_create_pairing,
            gateway_host::gateway_host_revoke,
            gateway_host::gateway_host_revoke_all,
            gateway_host::gateway_host_stop,
            harness_window::harness_open,
            harness_window::harness_close,
            runtime::runtime_status,
            runtime::runtime_start,
            runtime::runtime_stop,
            runtime::runtime_clear_plugin_quarantine,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            gateway_host::stop_managed(&state.gateway);
            runtime::stop_managed(&state.runtime);
        }
    });
}
