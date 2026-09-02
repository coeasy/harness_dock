mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod platform;
mod plugin_quarantine;
mod process;
mod runtime;
#[cfg(not(mobile))]
mod startup;
mod update;
#[cfg(not(mobile))]
mod tray;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub(crate) struct AppState {
    pub(crate) runtime: Mutex<Option<runtime::RuntimeProcess>>,
    pub(crate) runtime_starting: AtomicBool,
    pub(crate) runtime_restarting: AtomicBool,
    pub(crate) runtime_stopping: AtomicBool,
    pub(crate) web_action: AtomicBool,
    pub(crate) harness_loading: AtomicBool,
    pub(crate) harness_load_generation: AtomicU64,
    pub(crate) startup_recovery_error: Mutex<Option<String>>,
    pub(crate) settings_opening: AtomicBool,
    pub(crate) gateway: Mutex<Option<gateway_host::GatewayProcess>>,
    pub(crate) gateway_starting: Arc<AtomicBool>,
    pub(crate) starting_processes: process::StartingProcessRegistry,
    pub(crate) quitting: Arc<AtomicBool>,
    pub(crate) tray_available: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            runtime_starting: AtomicBool::new(false),
            runtime_restarting: AtomicBool::new(false),
            runtime_stopping: AtomicBool::new(false),
            web_action: AtomicBool::new(false),
            harness_loading: AtomicBool::new(false),
            harness_load_generation: AtomicU64::new(0),
            startup_recovery_error: Mutex::new(None),
            settings_opening: AtomicBool::new(false),
            gateway: Mutex::new(None),
            gateway_starting: Arc::new(AtomicBool::new(false)),
            starting_processes: Arc::new(Mutex::new(std::collections::HashSet::new())),
            quitting: Arc::new(AtomicBool::new(false)),
            tray_available: AtomicBool::new(false),
        }
    }
}

/// Synchronous, idempotent child cleanup used by both normal shutdown and the
/// updater's Windows pre-exit hook. The updater may terminate the host as part
/// of installer handoff, so it cannot rely on an async shutdown task alone.
pub(crate) fn stop_managed_processes(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    process::stop_starting_processes(&state.starting_processes);
    gateway_host::stop_managed(&state.gateway);
    runtime::stop_managed(&state.runtime);
}

pub(crate) async fn wait_for_managed_processes(app: tauri::AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            stop_managed_processes(&app);
            if process::starting_processes_empty(&state.starting_processes)
                && !state.runtime_starting.load(Ordering::Acquire)
                && !state.gateway_starting.load(Ordering::Acquire)
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!("HarnessDock shutdown timed out while waiting for startup tasks; forcing process exit.");
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // One final idempotent pass covers a startup task that published its
        // Child just as the last registry check completed.
        stop_managed_processes(&app);
    })
    .await;
}

#[cfg(not(mobile))]
pub(crate) fn report_shell_error(app: &tauri::AppHandle, error: &str) {
    eprintln!("HarnessDock shell action failed: {error}");
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.emit("harnessdock-shell-error", error.to_string());
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
        wait_for_managed_processes(handle.clone()).await;
        handle.exit(0);
    });
}

#[cfg(not(mobile))]
fn install_shell_menu(app: &mut tauri::App) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let shell = SubmenuBuilder::new(app, "HarnessDock")
        .text("shell-refresh-web", "刷新 Harness Web")
        .text("shell-restart-web", "重启并刷新 Harness Web")
        .text("shell-safe-mode", "隔离插件启动")
        .text("shell-clear-quarantine", "清除插件隔离并重启")
        .text("shell-gateway", "移动设备 / Gateway")
        .text("shell-settings", "插件诊断")
        .text("shell-update", "自动更新")
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
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_reload_web(handle).await {
                        report_shell_error(&report_handle, &error);
                    }
                });
            }
            "shell-restart-web" => {
                let handle = app_handle.clone();
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_restart_web(handle).await {
                        report_shell_error(&report_handle, &error);
                    }
                });
            }
            "shell-safe-mode" => {
                let handle = app_handle.clone();
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_safe_mode_restart(handle).await {
                        report_shell_error(&report_handle, &error);
                    }
                });
            }
            "shell-gateway" => {
                if let Err(error) = harness_window::control_show(app_handle.clone()) {
                    report_shell_error(app_handle, &error);
                }
            }
            "shell-settings" => {
                let handle = app_handle.clone();
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::shell_settings_show(handle).await {
                        report_shell_error(&report_handle, &error);
                    }
                });
            }
            "shell-clear-quarantine" => {
                let handle = app_handle.clone();
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_clear_quarantine_restart(handle).await {
                        report_shell_error(&report_handle, &error);
                    }
                });
            }
            "shell-update" => {
                let handle = app_handle.clone();
                let report_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = update::update_install(handle.clone()).await {
                        report_shell_error(&report_handle, &error);
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
                // Tray, updater integration and native menus are optional shell
                // enhancements. None of them may block the mandatory Runtime ->
                // Harness Web startup path when a desktop environment does not
                // support the feature or its initialization fails.
                match tray::create_tray(&app.handle()) {
                    Ok(()) => app
                        .state::<AppState>()
                        .tray_available
                        .store(true, Ordering::Release),
                    Err(error) => eprintln!(
                        "HarnessDock tray unavailable; closing the last client window will exit cleanly: {error}"
                    ),
                }
                if let Err(error) = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                {
                    eprintln!("HarnessDock updater plugin unavailable; continuing without automatic install: {error}");
                }
                // Startup is native-owned. The hidden `main` page is only a
                // recovery/secondary control surface and must not be responsible
                // for opening the first user-visible WebView.
                startup::spawn(app.handle().clone());
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
            harness_shell::harness_shell_close,
            harness_window::control_show,
            harness_window::harness_reload_web,
            harness_window::harness_restart_web,
            harness_window::harness_safe_mode_restart,
            harness_window::harness_clear_quarantine_restart,
            harness_window::shell_settings_show,
            harness_window::shell_settings_close,
            harness_window::splash_status,
            harness_window::startup_recovery_status,
            harness_window::app_quit,
            runtime::runtime_status,
            runtime::runtime_start,
            runtime::runtime_stop,
            runtime::runtime_clear_plugin_quarantine,
            update::update_check,
            update::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");

    #[cfg(not(mobile))]
    if let Err(error) = install_shell_menu(&mut app) {
        eprintln!("HarnessDock native menu unavailable; continuing with Harness Web: {error}");
    }

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
                api.prevent_close();
                let tray_available = app_handle
                    .state::<AppState>()
                    .tray_available
                    .load(Ordering::Acquire);
                if !tray_available {
                    // Without a tray, hiding the last window would strand an
                    // invisible process because ExitRequested is intentionally
                    // guarded during normal shell navigation. Fall back to the
                    // same managed shutdown path as the explicit Quit action.
                    request_exit(app_handle);
                    return;
                }

                // With a live tray, closing a client window means "hide to
                // tray". Only the explicit tray/settings Exit action terminates
                // the process.
                if label == "harness" {
                    harness_window::cancel_harness_load(app_handle);
                    harness_window::hide_splash(app_handle);
                }
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::Exit => {
                stop_managed_processes(app_handle);
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if !app_handle
                    .state::<AppState>()
                    .quitting
                    .load(std::sync::atomic::Ordering::SeqCst) =>
            {
                // Tauri can request an automatic exit when all windows are
                // temporarily hidden during WebView navigation. The splash,
                // tray, and native startup task are still alive in that
                // interval, so only the explicit quit coordinator may exit.
                api.prevent_exit();
            }
            _ => {}
        }
    });
}