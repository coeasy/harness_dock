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
    let settings = MenuItem::with_id(app, "tray-settings", "外壳设置", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "tray-restart", "重启 Runtime", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "tray-update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 HarnessDock", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &restart, &check_update, &quit])?;

    let _tray = TrayIconBuilder::with_id("harnessdock-tray")
        .tooltip("HarnessDock")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_primary(app),
            "tray-settings" => {
                let _ = harness_window::shell_settings_show(app.clone());
            }
            "tray-restart" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    match crate::runtime::runtime_restart(handle.clone()).await {
                        Ok(status) => {
                            if let Some(url) = status.app_url {
                                let _ = harness_window::harness_open(handle.clone(), url).await;
                            }
                        }
                        Err(error) => eprintln!("runtime restart from tray failed: {error}"),
                    }
                });
            }
            "tray-update" => {
                // The settings plugin owns the update UI. Keeping this action
                // non-blocking makes the tray responsive even during Runtime boot.
                let _ = harness_window::shell_settings_show(app.clone());
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
