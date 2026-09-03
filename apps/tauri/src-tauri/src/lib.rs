mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod lifecycle;
mod platform;
mod plugin_quarantine;
mod process;
mod runtime;
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

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

#[cfg(not(mobile))]
pub(crate) fn report_shell_error(app: &tauri::AppHandle, error: &str) {
    eprintln!("HarnessDock shell action failed: {error}");
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.emit("harnessdock-shell-error", error.to_string());
    }
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
    app.set_menu(menu)
        .map_err(|error| format!("无法安装 HarnessDock 菜单: {error}"))?;
    app.on_menu_event(
        |app_handle: &tauri::AppHandle, event| match event.id().0.as_str() {
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
                    if let Err(error) =
                        harness_window::harness_clear_quarantine_restart(handle).await
                    {
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
        },
    );
    Ok(())
}

fn visible_webview(app: &tauri::AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn has_primary_surface(app: &tauri::AppHandle) -> bool {
    if visible_webview(app, "harness") || visible_webview(app, "splash") {
        return true;
    }
    app.state::<AppState>()
        .harness_loading
        .load(Ordering::Acquire)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(mobile))]
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);

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
                        "HarnessDock tray unavailable; closing the primary client window will exit cleanly: {error}"
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
                    if label == "harness" {
                        // Without a tray the primary window is the only durable
                        // way back into the application. Closing it means quit.
                        harness_window::cancel_harness_load(app_handle);
                        harness_window::hide_splash(app_handle);
                        supervisor::request_exit(app_handle);
                        return;
                    }

                    if label == "main" && !has_primary_surface(app_handle) {
                        // Startup recovery can make `main` the only visible
                        // surface. Closing that sole recovery window must not
                        // strand a hidden Runtime process with no tray.
                        supervisor::request_exit(app_handle);
                        return;
                    }

                    // Diagnostics and the healthy Gateway control window are
                    // auxiliary surfaces. Closing them must never terminate a
                    // still-visible/loading Harness Web session just because
                    // this desktop environment lacks a tray implementation.
                    if let Some(window) = app_handle.get_webview_window(&label) {
                        let _ = window.hide();
                    }
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
                supervisor::stop_managed_processes(app_handle);
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
