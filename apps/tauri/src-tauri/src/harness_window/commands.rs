//! Tauri commands for window controls, splash status and settings windows.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[tauri::command]
pub async fn harness_open(app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, url);
        Err("Android/iOS 使用 Remote Gateway，不创建桌面 Harness 窗口。".into())
    }
    #[cfg(not(mobile))]
    {
        harness_open_impl(app, url, true).await
    }
}

pub(crate) async fn open_for_startup(app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, url);
        Err("Android/iOS 使用 Remote Gateway，不创建桌面 Harness 窗口。".into())
    }
    #[cfg(not(mobile))]
    {
        harness_open_impl(app, url, false).await
    }
}

#[tauri::command]
pub async fn harness_close(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(());
    }
    #[cfg(not(mobile))]
    {
        cancel_harness_load(&app);
        hide_splash(&app);
        if let Some(window) = app.get_webview_window("harness") {
            window
                .hide()
                .map_err(|error| format!("无法隐藏 Harness 窗口: {error}"))?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn harness_reload_web(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("移动端不提供桌面 Harness WebView 刷新命令。".into());
    }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::Refresh)?;
        let lease = current_runtime_lease(&app)?;
        let Some(window) = app.get_webview_window("harness") else {
            return harness_open(app.clone(), lease.launch_url).await;
        };
        let current = window
            .url()
            .ok()
            .and_then(|value| validated_runtime_url(value.as_str()).ok());
        let launch_url = validated_runtime_url(&lease.launch_url)?;
        if !runtime_listener_reachable(&launch_url) {
            let error = "Harness Runtime 本地 Web 监听不可达，无法刷新。".to_string();
            show_startup_recovery(&app, &error);
            return Err(error);
        }
        let navigation_id = begin_harness_load(&app, lease.generation.id)?;
        show_splash(&app, "正在刷新 Harness Web…");
        let result = if current.as_ref().is_some_and(|value| {
            value.origin().ascii_serialization() == lease.origin && !has_launch_token(value)
        }) {
            window.reload()
        } else {
            window.navigate(launch_url)
        };
        if let Err(error) = result {
            if let Ok(mut actor) = app.state::<crate::AppState>().surface_actor.lock() {
                let _ = actor.fail_navigation(navigation_id, lease.generation.id);
            }
            hide_splash(&app);
            show_startup_recovery(&app, &format!("无法刷新 Harness Web: {error}"));
            return Err(format!("无法刷新 Harness Web: {error}"));
        }
        schedule_harness_watchdog(&app, navigation_id, lease.generation.id);
        Ok(())
    }
}

#[tauri::command]
pub async fn harness_restart_web(app: AppHandle) -> Result<crate::runtime::RuntimeStatus, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 使用 Remote Gateway，不支持重启桌面 Runtime。".into());
    }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::Restart)?;
        restart_harness_web_impl(app, false, false).await
    }
}

#[tauri::command]
pub async fn harness_safe_mode_restart(
    app: AppHandle,
) -> Result<crate::runtime::RuntimeStatus, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 不支持桌面隔离插件启动。".into());
    }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::SafeMode)?;
        restart_harness_web_impl(app, false, true).await
    }
}

#[tauri::command]
pub async fn harness_clear_quarantine_restart(
    app: AppHandle,
) -> Result<crate::runtime::RuntimeStatus, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 不支持桌面插件隔离恢复。".into());
    }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::Restart)?;
        restart_harness_web_impl(app, true, false).await
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessWindowState {
    pub maximized: bool,
}

#[cfg(not(mobile))]
pub fn harness_window(app: &AppHandle) -> Result<tauri::WebviewWindow<tauri::Wry>, String> {
    app.get_webview_window("harness")
        .ok_or_else(|| "Harness Web 窗口尚未创建。".to_string())
}

#[tauri::command]
pub fn harness_minimize(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        harness_window(&app)?
            .minimize()
            .map_err(|error| format!("无法最小化 Harness 窗口: {error}"))
    }
}

#[tauri::command]
pub fn harness_toggle_maximize(app: AppHandle) -> Result<HarnessWindowState, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(HarnessWindowState { maximized: false })
    }
    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())?;
        } else {
            window.maximize().map_err(|error| error.to_string())?;
        }
        Ok(HarnessWindowState {
            maximized: window.is_maximized().unwrap_or(false),
        })
    }
}

#[tauri::command]
pub fn harness_window_state(app: AppHandle) -> Result<HarnessWindowState, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(HarnessWindowState { maximized: false })
    }
    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        Ok(HarnessWindowState {
            maximized: window.is_maximized().unwrap_or(false),
        })
    }
}

#[tauri::command]
pub fn control_show(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        let recovery = app
            .state::<crate::AppState>()
            .startup_recovery_error
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| Some("启动恢复状态不可用。".into()));
        if let Some(error) = recovery.as_deref() {
            show_control_surface(&app, "recovery", Some(error))
        } else {
            show_control_surface(&app, "gateway-host", None)
        }
    }
}

#[tauri::command]
pub fn splash_status(app: AppHandle, status: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, status);
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        set_splash_status(&app, &status);
        Ok(())
    }
}

#[tauri::command]
pub fn startup_recovery_status(app: AppHandle) -> Result<Option<String>, String> {
    app.state::<crate::AppState>()
        .startup_recovery_error
        .lock()
        .map(|recovery| recovery.clone())
        .map_err(|_| lock_err("StartupRecovery"))
}

#[cfg(not(mobile))]
pub async fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .show()
            .map_err(|error| format!("无法显示插件诊断窗口: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("无法聚焦插件诊断窗口: {error}"))?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("HarnessDock · 插件诊断")
        .inner_size(560.0, 520.0)
        .min_inner_size(480.0, 420.0)
        .resizable(true)
        .center()
        .visible(false)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
        .map_err(|error| format!("无法创建插件诊断窗口: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn shell_settings_show(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Err("移动端不提供桌面插件诊断窗口。".into())
    }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::Diagnostics)?;
        show_settings_window(&app).await
    }
}
