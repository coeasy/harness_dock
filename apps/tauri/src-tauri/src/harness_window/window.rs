//! WebView creation, navigation and restart orchestration.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[cfg(not(mobile))]
fn show_runtime_transition_error(app: &AppHandle, error: &str) {
    hide_primary_lifecycle_overlay(app);
    if let Some(window) = app.get_webview_window("harness") {
        // The old document may now point at a Runtime generation that no longer
        // exists. Hide only on actual failure; successful restart deliberately
        // keeps this painted frame visible until replacement navigation begins.
        let _ = window.hide();
    }
    show_startup_recovery(app, error);
}

#[cfg(not(mobile))]
pub async fn harness_open_impl(
    app: AppHandle,
    url: String,
    show_loading_surface: bool,
) -> Result<(), String> {
    if app
        .state::<crate::AppState>()
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("HarnessDock 正在退出，已拒绝打开 Harness Web。".into());
    }
    let runtime_url = validated_runtime_url(&url)?;
    let lease = current_runtime_lease(&app)?;
    if runtime_url.origin().ascii_serialization() != lease.origin {
        return Err("Harness Web URL 与当前 RuntimeLease origin 不一致。".into());
    }
    if !runtime_listener_reachable(&runtime_url) {
        return Err(
            "Harness Runtime 已发布地址，但本地 Web 监听不可达（127.0.0.1 拒绝连接）。".into(),
        );
    }

    if let Some(window) = app.get_webview_window("harness") {
        let current_url = window
            .url()
            .ok()
            .and_then(|current| validated_runtime_url(current.as_str()).ok());
        let same_origin = current_url
            .as_ref()
            .is_some_and(|current| current.origin().ascii_serialization() == lease.origin);
        let visible = app
            .state::<crate::AppState>()
            .surface_actor
            .lock()
            .map(|actor| actor.primary_visible())
            .unwrap_or(false);
        let recovery_pending = app
            .state::<crate::AppState>()
            .startup_recovery_error
            .lock()
            .map(|value| value.is_some())
            .unwrap_or(true);
        if same_origin
            && visible
            && !recovery_pending
            && current_url
                .as_ref()
                .is_some_and(|current| !has_launch_token(current))
        {
            let _ = window.show();
            let _ = window.set_focus();
            hide_splash(&app);
            return Ok(());
        }
        let navigation_id = begin_harness_load(&app, lease.generation.id)?;
        if show_loading_surface {
            show_splash(&app, "正在打开 Harness Web…");
        } else {
            hide_splash(&app);
        }
        let result = if same_origin
            && current_url
                .as_ref()
                .is_some_and(|current| !has_launch_token(current))
        {
            window.reload()
        } else {
            window.navigate(runtime_url)
        };
        if let Err(error) = result {
            if let Ok(mut actor) = app.state::<crate::AppState>().surface_actor.lock() {
                let _ = actor.fail_navigation(navigation_id, lease.generation.id);
            }
            let _ = window.hide();
            show_startup_recovery(&app, &format!("无法导航 Harness WebView: {error}"));
            return Err(format!("无法导航 Harness WebView: {error}"));
        }
        schedule_harness_watchdog(&app, navigation_id, lease.generation.id);
        return Ok(());
    }

    let navigation_id = begin_harness_load(&app, lease.generation.id)?;
    if show_loading_surface {
        show_splash(&app, "正在打开 Harness Web…");
    } else {
        hide_splash(&app);
    }
    let navigation_app = app.clone();
    let _window = WebviewWindowBuilder::new(&app, "harness", WebviewUrl::External(runtime_url))
        .title("HarnessDock · DeepSeek Harness")
        .initialization_script(init_script())
        .on_navigation(move |url| allowed_runtime_navigation(&navigation_app, url))
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                finish_harness_load(&window, payload.url());
            }
        })
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 560.0)
        .resizable(true)
        .decorations(false)
        .visible(false)
        .background_color(tauri::webview::Color(7, 16, 29, 255))
        .build()
        .map_err(|error| {
            if let Ok(mut actor) = app.state::<crate::AppState>().surface_actor.lock() {
                let _ = actor.fail_navigation(navigation_id, lease.generation.id);
            }
            show_startup_recovery(&app, &format!("无法创建 Harness WebView: {error}"));
            format!("无法创建 Harness WebView: {error}")
        })?;
    schedule_harness_watchdog(&app, navigation_id, lease.generation.id);
    Ok(())
}

#[cfg(not(mobile))]
pub async fn restart_harness_web_impl(
    app: AppHandle,
    clear_quarantine: bool,
    safe_mode: bool,
) -> Result<crate::runtime::RuntimeStatus, String> {
    let (mode, status_text) = if safe_mode {
        ("safe-mode", "正在启动 Rescue Web 并隔离第三方插件…")
    } else if clear_quarantine {
        ("restart", "正在恢复全部插件并正常重启…")
    } else {
        ("restart", "正在重启 Runtime…")
    };
    let overlay_visible = show_primary_lifecycle_overlay(&app, mode, status_text);
    if overlay_visible {
        tokio::time::sleep(std::time::Duration::from_millis(48)).await;
    }

    cancel_harness_load(&app);
    let reopen_epoch = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation().0)
        .unwrap_or_default();
    if clear_quarantine {
        crate::runtime::runtime_clear_plugin_quarantine(app.clone()).map_err(|error| {
            show_runtime_transition_error(&app, &error);
            error
        })?;
        crate::runtime::restore_normal_startup_policy(&app).map_err(|error| {
            show_runtime_transition_error(&app, &error);
            error
        })?;
    }
    let status = if safe_mode {
        crate::runtime::restart_managed_safe(app.clone()).await
    } else {
        crate::runtime::restart_managed(app.clone()).await
    }
    .map_err(|error| {
        show_runtime_transition_error(&app, &error);
        error
    })?;
    let current_epoch = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation().0)
        .unwrap_or_default();
    if current_epoch != reopen_epoch {
        hide_primary_lifecycle_overlay(&app);
        hide_splash(&app);
        return Ok(status);
    }
    let Some(url) = status.app_url.clone() else {
        let error = "Runtime 重启后没有返回 Harness Web 地址。".to_string();
        show_runtime_transition_error(&app, &error);
        return Err(error);
    };
    set_primary_lifecycle_status(&app, "Runtime 已就绪，正在恢复 Harness Web…");
    harness_open_impl(app.clone(), url, false)
        .await
        .map_err(|error| {
            show_runtime_transition_error(&app, &error);
            error
        })?;
    Ok(status)
}
