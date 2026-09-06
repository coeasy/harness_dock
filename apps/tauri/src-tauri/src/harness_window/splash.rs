//! Splash, control surface and startup-recovery panel presentation.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[cfg(not(mobile))]
pub(crate) fn hide_splash(app: &AppHandle) {
    // The progress surface is created only for explicit restart/safe-mode
    // operations. Destroy it after use so normal steady state has no hidden
    // renderer consuming memory or participating in shutdown.
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.close();
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
    if let Some(window) = app.get_webview_window("splash") {
        set_splash_status(app, status);
        let _ = window.show();
        return;
    }

    let status = status.to_string();
    let result = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .title("HarnessDock")
        .inner_size(420.0, 300.0)
        .resizable(false)
        .center()
        .decorations(false)
        .visible(false)
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            if let Ok(value) = serde_json::to_string(&status) {
                let _ = window.eval(format!("window.__harnessDockSetStatus({value})"));
            }
            let _ = window.show();
        })
        .build();
    if let Err(error) = result {
        eprintln!("Unable to create on-demand HarnessDock progress surface: {error}");
    }
}

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
    hide_splash(app);
    if let Some(window) = app.get_webview_window("control") {
        set_control_surface(&window, mode, error);
        window
            .show()
            .map_err(|error| format!("无法显示 HarnessDock 按需控制面: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("无法聚焦 HarnessDock 按需控制面: {error}"))?;
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
    let primary_visible = if let Ok(mut surface) = state.surface_actor.lock() {
        let primary_visible = surface.primary_visible();
        let (navigation, generation) = surface.current_navigation();
        if let Some(generation) = generation {
            let _ = surface.fail_navigation(navigation, generation);
        }
        surface.end_operation();
        primary_visible
    } else {
        false
    };

    if !primary_visible {
        if let Some(window) = app.get_webview_window("harness") {
            let _ = window.hide();
        }
    }

    eprintln!("HarnessDock startup failed: {error}");
    if let Err(surface_error) = show_control_surface(app, "recovery", Some(error)) {
        eprintln!("HarnessDock recovery surface unavailable: {surface_error}");
    }
}

pub fn clear_startup_recovery(app: &AppHandle) {
    if let Ok(mut recovery) = app.state::<crate::AppState>().startup_recovery_error.lock() {
        *recovery = None;
    }
}
