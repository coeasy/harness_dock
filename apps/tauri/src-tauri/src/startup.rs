//! Native desktop startup coordinator.
//!
//! Normal launch has no hidden renderer dependency: verify sealed Runtime ->
//! spawn/probe actor generation -> request Harness surface. Recovery/Gateway
//! control surfaces are created only when explicitly needed.

use crate::{
    harness_window, reconciler,
    startup_trace::{self, StartupPhase},
    AppState,
};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager};

/// WebView2/WebKit may report the authenticated `?token=` load event after the
/// browser has already followed dsh's 303 to the clean `/` URL. The normal
/// `on_page_load` callback remains authoritative, but startup must not leave a
/// healthy Harness document hidden forever when that event/current-URL pair is
/// reordered by the platform WebView.
///
/// After the Runtime has already passed the browser-faithful readiness probe,
/// observe the actual WebView URL for a short stability window. If it has
/// settled on the current managed Runtime origin without the one-time launch
/// token, publish the primary surface with native decorations. A later shell
/// callback may still replace those native decorations with Harness Shell.
async fn reveal_clean_runtime_fallback(app: &AppHandle) -> Result<(), String> {
    let mut stable_clean_polls = 0_u8;
    for _ in 0..50 {
        if app.state::<AppState>().quitting.load(Ordering::Acquire) {
            return Ok(());
        }

        let already_visible = app
            .state::<AppState>()
            .surface_actor
            .lock()
            .map(|actor| actor.primary_visible())
            .unwrap_or(false);
        if already_visible {
            return Ok(());
        }

        let Some(window) = app.get_webview_window("harness") else {
            stable_clean_polls = 0;
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(100));
            })
            .await;
            continue;
        };
        let Some(lease) = crate::runtime::live_lease(&*app.state::<AppState>()) else {
            return Err("Harness WebView 已创建，但当前 RuntimeLease 已失效。".into());
        };

        let clean_managed_url = window.url().ok().is_some_and(|current| {
            current.origin().ascii_serialization() == lease.origin
                && !current
                    .query_pairs()
                    .any(|(key, value)| key == "token" && !value.is_empty())
        });
        if clean_managed_url {
            stable_clean_polls = stable_clean_polls.saturating_add(1);
        } else {
            stable_clean_polls = 0;
        }

        if stable_clean_polls >= 5 {
            let claimed = app
                .state::<AppState>()
                .surface_actor
                .lock()
                .map(|mut actor| {
                    if actor.primary_visible() {
                        return false;
                    }
                    let (navigation_id, generation) = actor.current_navigation();
                    generation == Some(lease.generation.id)
                        && actor.finish_navigation(navigation_id, lease.generation.id)
                })
                .unwrap_or(false);

            if claimed {
                // Fail open to native window controls. If the normal page-load
                // callback subsequently installs Harness Shell successfully it
                // will switch decorations off again.
                let _ = window.set_decorations(true);
                window
                    .show()
                    .map_err(|error| format!("无法显示已就绪的 Harness WebView: {error}"))?;
                let _ = window.set_focus();
                if let Some(control) = app.get_webview_window("control") {
                    let _ = control.close();
                }
                harness_window::hide_splash(app);
                startup_trace::mark(StartupPhase::NativeFallback);
                startup_trace::mark(StartupPhase::PrimaryVisible);
                return Ok(());
            }
        }

        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(100));
        })
        .await;
    }
    Ok(())
}

pub(crate) fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        harness_window::show_splash(&app, "正在验证内置 Harness Runtime…");
        let status = match reconciler::ensure_runtime_for_boot(app.clone()).await {
            Ok(status) => status,
            Err(error) => {
                startup_trace::mark(StartupPhase::Recovery);
                harness_window::show_startup_recovery(&app, &error);
                return;
            }
        };
        let Some(url) = status.app_url else {
            startup_trace::mark(StartupPhase::Recovery);
            harness_window::show_startup_recovery(
                &app,
                "Runtime 已启动，但没有返回 Harness Web 地址。",
            );
            return;
        };
        harness_window::show_splash(&app, "正在打开 Harness Web…");
        startup_trace::mark(StartupPhase::WebviewRequested);
        if let Err(error) = harness_window::open_for_startup(app.clone(), url).await {
            startup_trace::mark(StartupPhase::Recovery);
            harness_window::show_startup_recovery(&app, &error);
            return;
        }
        if let Err(error) = reveal_clean_runtime_fallback(&app).await {
            startup_trace::mark(StartupPhase::Recovery);
            harness_window::show_startup_recovery(&app, &error);
        }
    });
}
