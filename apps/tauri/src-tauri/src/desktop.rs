//! Native desktop adapter.
//!
//! Window/menu/tray/run-loop integration belongs here. The adapter translates
//! native UI events into typed intents; Runtime/Gateway/Update procedure order
//! belongs exclusively to the Reconciler and Resource Actors.

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

use crate::{service::workflow, AppState};

pub(crate) fn report_shell_error(app: &tauri::AppHandle, error: &str) {
    eprintln!("HarnessDock shell action failed: {error}");
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.emit("harnessdock-shell-error", error.to_string());
    }
}

pub(crate) fn spawn_intent(app: &tauri::AppHandle, intent: workflow::HostIntent) {
    let handle = app.clone();
    let report_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = workflow::execute(handle, intent).await {
            report_shell_error(&report_handle, &error);
        }
    });
}

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
        .text("shell-hide-to-tray", "隐藏到托盘")
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单项: {error}"))?;
    let menu = MenuBuilder::new(app)
        .item(&shell)
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 菜单: {error}"))?;
    app.set_menu(menu)
        .map_err(|error| format!("无法安装 HarnessDock 菜单: {error}"))?;
    app.on_menu_event(|app_handle: &tauri::AppHandle, event| {
        let intent = match event.id().0.as_str() {
            "shell-refresh-web" => Some(workflow::HostIntent::RefreshHarness),
            "shell-restart-web" => Some(workflow::HostIntent::RestartRuntime),
            "shell-safe-mode" => Some(workflow::HostIntent::StartSafeMode),
            "shell-clear-quarantine" => Some(workflow::HostIntent::ClearQuarantine),
            "shell-gateway" => Some(workflow::HostIntent::ShowGateway),
            "shell-settings" => Some(workflow::HostIntent::ShowDiagnostics),
            "shell-update" => Some(workflow::HostIntent::InstallUpdate),
            "shell-hide-to-tray" => {
                if let Err(error) = crate::tray::hide_primary(app_handle) {
                    report_shell_error(app_handle, &error);
                }
                None
            }
            _ => None,
        };
        if let Some(intent) = intent {
            spawn_intent(app_handle, intent);
        }
    });
    Ok(())
}

fn visible_webview(app: &tauri::AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn has_primary_surface(app: &tauri::AppHandle) -> bool {
    visible_webview(app, "harness")
        || visible_webview(app, "splash")
        || app
            .state::<AppState>()
            .surface_actor
            .lock()
            .map(|actor| actor.primary_visible())
            .unwrap_or(false)
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    crate::host_kernel::install(app.handle().clone()).map_err(std::io::Error::other)?;

    match crate::tray::create_tray(&app.handle()) {
        Ok(()) => app
            .state::<AppState>()
            .tray_available
            .store(true, Ordering::Release),
        Err(error) => eprintln!(
            "HarnessDock tray unavailable; continuing without tray controls: {error}"
        ),
    }
    if let Err(error) = app
        .handle()
        .plugin(tauri_plugin_updater::Builder::new().build())
    {
        eprintln!("HarnessDock updater unavailable; continuing without automatic install: {error}");
    }
    if let Err(error) = install_shell_menu(app) {
        eprintln!("HarnessDock native menu unavailable; continuing with Harness Web: {error}");
    }
    crate::startup::spawn(app.handle().clone());
    Ok(())
}

pub(crate) fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if !app_handle
            .state::<AppState>()
            .quitting
            .load(Ordering::SeqCst)
            && label == "harness" =>
        {
            // The native title-bar close button and Alt+F4 have the same
            // contract as the independent Harness Shell X: close means a
            // supervised process exit. Tray visibility is an explicit native
            // action and never changes the meaning of a close request.
            api.prevent_close();
            crate::supervisor::request_exit(app_handle);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == "control" && !has_primary_surface(app_handle) => {
            if !app_handle
                .state::<AppState>()
                .tray_available
                .load(Ordering::Acquire)
            {
                crate::supervisor::request_exit(app_handle);
            }
        }
        tauri::RunEvent::Exit => {
            crate::supervisor::stop_managed_processes(app_handle);
        }
        tauri::RunEvent::ExitRequested { api, .. }
            if !app_handle
                .state::<AppState>()
                .quitting
                .load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
        }
        _ => {}
    }
}
