mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod platform;
mod plugin_quarantine;
mod runtime;
mod update;
#[cfg(not(mobile))]
mod tray;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::Manager;

pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
    pub(crate) gateway: Mutex<Option<gateway_host::GatewayProcess>>,
    pub(crate) quitting: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            gateway: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }
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
            let _ = harness_window::shell_settings_show(app_handle.clone());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                // Create both entry points before Runtime boot. A Runtime or
                // plugin failure must never remove the user's exit path.
                tray::create_tray(&app.handle())?;
                let _ = harness_window::prewarm_settings_window(&app.handle());
            }
            Ok(())
        })
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
            harness_window::harness_minimize,
            harness_window::harness_toggle_maximize,
            harness_window::harness_window_state,
            harness_window::control_show,
            harness_window::shell_settings_show,
            harness_window::shell_settings_close,
            runtime::runtime_status,
            runtime::runtime_start,
            runtime::runtime_restart,
            runtime::runtime_stop,
            runtime::runtime_clear_plugin_quarantine,
            update::update_check,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    #[cfg(not(mobile))]
    install_shell_menu(&mut app).expect("failed to install HarnessDock shell settings menu");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if !app_handle
                .state::<AppState>()
                .quitting
                .load(std::sync::atomic::Ordering::SeqCst)
                && (label == "main" || label == "harness") =>
            {
                // Closing a window means "hide to tray". Only the explicit
                // tray/menu Exit action terminates the application.
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<AppState>();
                gateway_host::stop_managed(&state.gateway);
                runtime::stop_managed(&state.runtime);
            }
            _ => {}
        }
    });
}
