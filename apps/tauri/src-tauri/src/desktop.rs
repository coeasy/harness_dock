//! Native desktop adapter.
//!
//! Window/menu/tray/run-loop integration belongs here. The adapter translates
//! native UI events into application intents and must not own Runtime process
//! handles or cross-service lifecycle policy.

use std::{env, sync::atomic::Ordering};
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

    app.on_menu_event(|app_handle: &tauri::AppHandle, event| {
        let intent = match event.id().0.as_str() {
            "shell-refresh-web" => Some(workflow::HostIntent::RefreshHarness),
            "shell-restart-web" => Some(workflow::HostIntent::RestartRuntime),
            "shell-safe-mode" => Some(workflow::HostIntent::StartSafeMode),
            "shell-clear-quarantine" => Some(workflow::HostIntent::ClearQuarantine),
            "shell-gateway" => Some(workflow::HostIntent::ShowGateway),
            "shell-settings" => Some(workflow::HostIntent::ShowDiagnostics),
            "shell-update" => Some(workflow::HostIntent::InstallUpdate),
            _ => None,
        };
        if let Some(intent) = intent {
            spawn_intent(app_handle, intent);
        }
    });
    Ok(())
}

#[cfg(not(mobile))]
fn configure_embedded_runtime_tool_path(app: &tauri::App) -> Result<(), String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法解析 HarnessDock resource 目录: {error}"))?;
    let runtime = resources.join("dsh-runtime");
    let tool_bin = runtime.join("tools").join("bin");

    // Source-only/dev launches can intentionally use a developer Runtime and
    // therefore have no packaged tools directory. A production Candidate is
    // separately gated to contain the embedded Runtime and bundled pnpm.
    if !tool_bin.is_dir() {
        return Ok(());
    }

    let node_bin = if cfg!(windows) {
        runtime
    } else {
        runtime.join("bin")
    };
    let current = env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![tool_bin, node_bin];
    entries.extend(env::split_paths(&current));
    let joined = env::join_paths(entries)
        .map_err(|error| format!("无法配置内置 Runtime 工具 PATH: {error}"))?;
    env::set_var("PATH", joined);
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

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(not(mobile))]
    {
        if let Err(error) = configure_embedded_runtime_tool_path(app) {
            eprintln!(
                "HarnessDock bundled plugin-management tools unavailable; Harness Web will continue: {error}"
            );
        }

        // Tray, updater and native menu are optional shell enhancements. They
        // fail open and must never block the bundled Runtime -> Harness Web
        // startup path.
        match crate::tray::create_tray(&app.handle()) {
            Ok(()) => app
                .state::<AppState>()
                .tray_available
                .store(true, Ordering::Release),
            Err(error) => eprintln!(
                "HarnessDock tray unavailable; primary-window close will exit cleanly: {error}"
            ),
        }
        if let Err(error) = app
            .handle()
            .plugin(tauri_plugin_updater::Builder::new().build())
        {
            eprintln!(
                "HarnessDock updater plugin unavailable; continuing without automatic install: {error}"
            );
        }
        if let Err(error) = install_shell_menu(app) {
            eprintln!("HarnessDock native menu unavailable; continuing with Harness Web: {error}");
        }

        // Startup is native-owned. The currently bundled Runtime is expected
        // to already exist in application resources; first launch must not
        // fetch Node or dsh from the network.
        crate::startup::spawn(app.handle().clone());
    }
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
            && (label == "main" || label == "harness" || label == "settings") =>
        {
            api.prevent_close();
            let tray_available = app_handle
                .state::<AppState>()
                .tray_available
                .load(Ordering::Acquire);

            if !tray_available {
                if label == "harness" {
                    crate::harness_window::cancel_harness_load(app_handle);
                    crate::harness_window::hide_splash(app_handle);
                    crate::supervisor::request_exit(app_handle);
                    return;
                }

                if label == "main" && !has_primary_surface(app_handle) {
                    crate::supervisor::request_exit(app_handle);
                    return;
                }

                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                }
                return;
            }

            if label == "harness" {
                crate::harness_window::cancel_harness_load(app_handle);
                crate::harness_window::hide_splash(app_handle);
            }
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.hide();
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
            // Tauri may request an automatic exit while all windows are hidden
            // during navigation. Only the explicit supervisor may terminate
            // the process so in-flight Runtime cleanup cannot be bypassed.
            api.prevent_exit();
        }
        _ => {}
    }
}
