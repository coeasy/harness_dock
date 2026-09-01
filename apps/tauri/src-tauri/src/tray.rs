use crate::harness_window;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

fn show_primary(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "打开 Harness", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "插件诊断", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "tray-refresh", "刷新 Harness Web", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "tray-restart", "重启 Runtime 并刷新 Web", true, None::<&str>)?;
    let clear_quarantine = MenuItem::with_id(app, "tray-clear-quarantine", "清除插件隔离并重启", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "tray-update", "自动更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 HarnessDock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &refresh, &restart, &clear_quarantine, &update, &quit])?;

    let _tray = TrayIconBuilder::with_id("harnessdock-tray")
        .tooltip("HarnessDock")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_primary(app),
            "tray-settings" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::shell_settings_show(handle).await {
                        eprintln!("plugin diagnostics from tray failed: {error}");
                    }
                });
            }
            "tray-refresh" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_reload_web(handle).await {
                        eprintln!("Web refresh from tray failed: {error}");
                    }
                });
            }
            "tray-restart" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    match harness_window::harness_restart_web(handle).await {
                        Ok(_) => {}
                        Err(error) => eprintln!("runtime restart from tray failed: {error}"),
                    }
                });
            }
            "tray-clear-quarantine" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = harness_window::harness_clear_quarantine_restart(handle).await {
                        eprintln!("plugin recovery from tray failed: {error}");
                    }
                });
            }
            "tray-update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::update::update_install(handle.clone()).await {
                        eprintln!("Automatic update from tray failed: {error}");
                        if let Err(open_error) = harness_window::shell_settings_show(handle).await {
                            eprintln!("Plugin diagnostics fallback failed: {open_error}");
                        }
                    }
                });
            }
            "tray-quit" => {
                crate::request_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_primary(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
