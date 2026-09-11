//! Splash, control surface and startup-recovery panel presentation.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[cfg(not(mobile))]
pub(crate) fn hide_splash(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.hide();
    }
}

#[cfg(mobile)]
pub(crate) fn hide_splash(_app: &AppHandle) {}

#[cfg(not(mobile))]
pub fn set_splash_status(app: &AppHandle, status: &str) {
    let Some(window) = app.get_webview_window("splash") else {
        return;
    };
    let Ok(value) = serde_json::to_string(status) else {
        return;
    };
    let _ = window.eval(format!("window.__harnessDockSetStatus({value})"));
}

#[cfg(not(mobile))]
pub(crate) fn show_splash(app: &AppHandle, status: &str) {
    set_splash_status(app, status);
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.show();
    }
}

/// Runtime operations after the primary Harness surface is visible stay inside
/// that already-painted WebView. Re-showing the independent splash WebView here
/// can expose an unpainted WebView2 frame and produces the visible white flash
/// that this boundary is designed to avoid.
#[cfg(not(mobile))]
pub(crate) fn show_primary_lifecycle_overlay(
    app: &AppHandle,
    mode: &str,
    status: &str,
) -> bool {
    let Some(window) = app.get_webview_window("harness") else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let (Ok(mode), Ok(status)) = (serde_json::to_string(mode), serde_json::to_string(status)) else {
        return false;
    };
    window
        .eval(format!(
            "window.__HARNESSDOCK_LIFECYCLE__?.show({status}, {mode})"
        ))
        .is_ok()
}

#[cfg(mobile)]
pub(crate) fn show_primary_lifecycle_overlay(
    _app: &AppHandle,
    _mode: &str,
    _status: &str,
) -> bool {
    false
}

#[cfg(not(mobile))]
pub(crate) fn set_primary_lifecycle_status(app: &AppHandle, status: &str) {
    let Some(window) = app.get_webview_window("harness") else {
        return;
    };
    let Ok(status) = serde_json::to_string(status) else {
        return;
    };
    let _ = window.eval(format!(
        "window.__HARNESSDOCK_LIFECYCLE__?.update({status})"
    ));
}

#[cfg(mobile)]
pub(crate) fn set_primary_lifecycle_status(_app: &AppHandle, _status: &str) {}

#[cfg(not(mobile))]
pub(crate) fn hide_primary_lifecycle_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.eval("window.__HARNESSDOCK_LIFECYCLE__?.hide()");
    }
}

#[cfg(mobile)]
pub(crate) fn hide_primary_lifecycle_overlay(_app: &AppHandle) {}

#[cfg(not(mobile))]
pub fn set_control_surface(
    window: &tauri::WebviewWindow<tauri::Wry>,
    mode: &str,
    error: Option<&str>,
) {
    if let Ok(value) = serde_json::to_string(mode) {
        let _ = window.eval(format!("window.__harnessDockSetSurface?.({value})"));
    }
    if let Some(error) = error {
        if let Ok(value) = serde_json::to_string(error) {
            let _ = window.eval(format!("window.__harnessDockShowRecovery?.({value})"));
        }
    }
}

#[cfg(not(mobile))]
pub fn show_control_surface(
    app: &AppHandle,
    mode: &str,
    error: Option<&str>,
) -> Result<(), String> {
    // Keep the splash visible until the secondary surface is actually painted.
    // Hiding it before a lazily-created recovery/diagnostics WebView finishes
    // loading creates a blank gap that feels like the app froze.
    if let Some(window) = app.get_webview_window("control") {
        set_control_surface(&window, mode, error);
        window
            .show()
            .map_err(|error| format!("无法显示 HarnessDock 按需控制面: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("无法聚焦 HarnessDock 按需控制面: {error}"))?;
        hide_splash(app);
        return Ok(());
    }

    let mode = mode.to_string();
    let recovery = error.map(str::to_string);
    WebviewWindowBuilder::new(app, "control", WebviewUrl::App("index.html".into()))
        .title("HarnessDock")
        .inner_size(760.0, 680.0)
        .min_inner_size(640.0, 520.0)
        .resizable(true)
        .center()
        .visible(false)
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                set_control_surface(&window, &mode, recovery.as_deref());
                let _ = window.show();
                let _ = window.set_focus();
                hide_splash(window.app_handle());
            }
        })
        .build()
        .map_err(|error| format!("无法创建 HarnessDock 按需控制面: {error}"))?;
    Ok(())
}

#[cfg(not(mobile))]
pub(crate) fn show_startup_recovery(app: &AppHandle, error: &str) {
    let state = app.state::<crate::AppState>();
    if let Ok(mut recovery) = state.startup_recovery_error.lock() {
        *recovery = Some(error.to_string());
    }
    if let Ok(mut surface) = state.surface_actor.lock() {
        let (navigation, generation) = surface.current_navigation();
        if let Some(generation) = generation {
            let _ = surface.fail_navigation(navigation, generation);
        }
        surface.end_operation();
    }
    eprintln!("HarnessDock startup failed: {error}");
    show_splash(app, "启动失败，正在打开恢复入口…");
    if let Err(surface_error) = show_control_surface(app, "recovery", Some(error)) {
        eprintln!("HarnessDock recovery surface unavailable: {surface_error}");
        set_splash_status(app, "启动失败，恢复入口暂不可用");
    }
}

pub fn clear_startup_recovery(app: &AppHandle) {
    if let Ok(mut recovery) = app.state::<crate::AppState>().startup_recovery_error.lock() {
        *recovery = None;
    }
}
