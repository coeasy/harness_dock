mod gateway;
mod gateway_host;
mod harness_shell;
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

#[cfg(not(mobile))]
fn install_shell_menu(app: &mut tauri::App) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let shell = SubmenuBuilder::new(app, "HarnessDock")
        .text("shell-settings", "外壳设置")
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单项: {error}"))?;
    let menu = MenuBuilder::new(app)
        .item(&shell)
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单: {error}"))?;
    app.set_menu(menu).map_err(|error| format!("无法安装 HarnessDock 菜单: {error}"))?;
    app.on_menu_event(|app_handle: &tauri::AppHandle, event| {
        if event.id().0.as_str() == "shell-settings" {
            let _ = harness_window::control_show(app_handle.clone());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default()
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
            harness_window::control_show,
            harness_window::shell_settings_show,
            runtime::runtime_status,
            runtime::runtime_start,
            runtime::runtime_stop,
            runtime::runtime_clear_plugin_quarantine,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    #[cfg(not(mobile))]
    install_shell_menu(&mut app).expect("failed to install HarnessDock shell settings menu");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            gateway_host::stop_managed(&state.gateway);
            runtime::stop_managed(&state.runtime);
        }
    });
}
