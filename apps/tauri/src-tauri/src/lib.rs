mod gateway;
mod platform;
mod runtime;

use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            platform::platform_info,
            gateway::gateway_health,
            gateway::pair_gateway,
            runtime::runtime_status,
            runtime::runtime_start,
            runtime::runtime_stop,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            runtime::stop_managed(&state.runtime);
        }
    });
}
