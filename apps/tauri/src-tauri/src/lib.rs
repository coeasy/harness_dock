mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod platform;
mod plugin_quarantine;
mod process;
mod runtime;
mod update;
#[cfg(not(mobile))]
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
    pub(crate) runtime_starting: AtomicBool,
    pub(crate) runtime_restarting: AtomicBool,
    pub(crate) web_action: AtomicBool,
    pub(crate) settings_opening: AtomicBool,
    pub(crate) gateway: Mutex<Option<gateway_host::GatewayProcess>>,
    pub(crate) starting_processes: process::StartingProcessRegistry,
    pub(crate) quitting: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            runtime_starting: AtomicBool::new(false),
            runtime_restarting: AtomicBool::new(false),
            web_action: AtomicBool::new(false),
            settings_opening: AtomicBool::new(false),
            gateway: Mutex::new(None),
            starting_processes: Arc::new(Mutex::new(std::collections::HashSet::new())),
            quitting: AtomicBool::new(false),
        }
    }
}

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }

    // Do not terminate the Tauri process until every managed child has had a
    // chance to leave. Runtime/Gateway startup uses blocking tasks, so an
    // immediate app.exit() here can race the task after it has spawned Node but
    // before it has published the Child into AppState.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let cleanup_handle = handle.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let state = cleanup_handle.state::<AppState>();
            for _ in 0..50 {
                process::stop_starting_processes(&state.starting_processes);
                gateway_host::stop_managed(&state.gateway);
                runtime::stop_managed(&state.runtime);
                if process::starting_processes_empty(&state.starting_processes) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // One final idempotent pass covers a startup task that published
            // its Child just as the last registry check completed.
            process::stop_starting_processes(&state.starting_processes);
            gateway_host::stop_managed(&state.gateway);
            runtime::stop_managed(&state.runtime);
        })
        .await;
        handle.exit(0);
    });
}

#[cfg(not(mobile))]
fn install_shell_menu(app: &mut tauri::App) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let shell = SubmenuBuilder::new(app, "HarnessDock")
        .text("shell-refresh-web", "刷新 Harness Web")
        .text("shell-restart-web", "重启并刷新 Harness Web")
        .text("shell-settings", "外壳设置")
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单项: {error}"))?;
    let menu = MenuBuilder::new(app)
        .item(&shell)
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单: {error}"))?;
    app.set_menu(menu).map_err(|error| format!("无法安装 HarnessDock 菜单: {error}"))?;
    app.on_menu_event(|app_handle: &tauri::AppHandle, event| {
        match event.id().0.as_str() {
            "shell-refresh-web" => {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_reload_web(handle).await {
                        eprintln!("Web refresh from app menu failed: {error}");
                    }
                });
            }
            "shell-restart-web" => {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_restart_web(handle).await {
                        eprintln!("Web restart from app menu failed: {error}");
                    }
                });
            }
            "shell-settings" => {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::shell_settings_show(handle).await {
                        eprintln!("Shell settings from app menu failed: {error}");
                    }
                });
            }
            _ => {}
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
            harness_window::harness_reload_web,
            harness_window::harness_restart_web,
            harness_window::shell_settings_show,
            harness_window::shell_settings_close,
            harness_window::app_quit,
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
                && (label == "main" || label == "harness" || label == "settings") =>
            {
                // Closing any client window means "hide to tray". Only the
                // explicit tray/settings Exit action terminates the process.
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<AppState>();
                process::stop_starting_processes(&state.starting_processes);
                gateway_host::stop_managed(&state.gateway);
                runtime::stop_managed(&state.runtime);
            }
            _ => {}
        }
    });
}
