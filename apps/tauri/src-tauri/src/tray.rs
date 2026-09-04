use crate::{desktop, service::workflow};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use url::Url;

fn show_primary(app: &AppHandle) {
    let lease = crate::runtime::live_lease(&*app.state::<crate::AppState>());
    if let Some(window) = app.get_webview_window("harness") {
        // SurfaceActor is the only source of truth for Harness navigation.
        // Never reintroduce a parallel harness_loading AtomicBool.
        let loading = app
            .state::<crate::AppState>()
            .surface_actor
            .lock()
            .map(|surface| surface.phase() == crate::surface_actor::SurfacePhase::Loading)
            .unwrap_or(false);
        if loading && lease.is_some() {
            if let Some(splash) = app.get_webview_window("splash") {
                let _ = splash.show();
                let _ = splash.set_focus();
            }
            return;
        }
        if lease.as_ref().is_some_and(|lease| {
            window
                .url()
                .ok()
                .and_then(|url| Url::parse(url.as_str()).ok())
                .is_some_and(|url| url.origin().ascii_serialization() == lease.origin)
        }) {
            // Re-open through the Host Kernel so a tray click revalidates the
            // current RuntimeLease instead of resurfacing an old Runtime URL.
            desktop::spawn_intent(app, workflow::HostIntent::ActivatePrimary);
            return;
        }
        let _ = window.hide();
    }
    if lease.is_some() {
        desktop::spawn_intent(app, workflow::HostIntent::ActivatePrimary);
        return;
    }
    if let Some(window) = app.get_webview_window("splash") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
    }
    if let Some(window) = app.get_webview_window("control") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "打开 Harness", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "插件诊断", true, None::<&str>)?;
    let gateway = MenuItem::with_id(
        app,
        "tray-gateway",
        "移动设备 / Gateway",
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(app, "tray-refresh", "刷新 Harness Web", true, None::<&str>)?;
    let restart = MenuItem::with_id(
        app,
        "tray-restart",
        "重启 Runtime 并刷新 Web",
        true,
        None::<&str>,
    )?;
    let safe_mode = MenuItem::with_id(app, "tray-safe-mode", "隔离插件启动", true, None::<&str>)?;
    let clear_quarantine = MenuItem::with_id(
        app,
        "tray-clear-quarantine",
        "清除插件隔离并重启",
        true,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "tray-update", "自动更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 HarnessDock", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &settings,
            &gateway,
            &refresh,
            &restart,
            &safe_mode,
            &clear_quarantine,
            &update,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("harnessdock-tray")
        .tooltip("HarnessDock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let intent = match event.id.as_ref() {
                "tray-open" => {
                    show_primary(app);
                    None
                }
                "tray-settings" => Some(workflow::HostIntent::ShowDiagnostics),
                "tray-gateway" => Some(workflow::HostIntent::ShowGateway),
                "tray-refresh" => Some(workflow::HostIntent::RefreshHarness),
                "tray-restart" => Some(workflow::HostIntent::RestartRuntime),
                "tray-safe-mode" => Some(workflow::HostIntent::StartSafeMode),
                "tray-clear-quarantine" => Some(workflow::HostIntent::ClearQuarantine),
                "tray-update" => Some(workflow::HostIntent::InstallUpdate),
                "tray-quit" => {
                    // Quit is a lifecycle escape hatch, not a business command.
                    // It must never wait behind a busy or unavailable Host Kernel queue.
                    crate::request_exit(app);
                    None
                }
                _ => None,
            };
            if let Some(intent) = intent {
                desktop::spawn_intent(app, intent);
            }
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
        });

    // Tray is optional. Failure to build it is handled fail-open by desktop setup.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let _tray = builder.build(app)?;
    Ok(())
}
