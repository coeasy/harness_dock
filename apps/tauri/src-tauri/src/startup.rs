//! Native desktop startup coordinator.
//!
//! The desktop creates the real Harness window immediately with a local,
//! non-privileged bootstrap document. Runtime preparation runs asynchronously;
//! when the sealed Runtime publishes its lease the same WebView navigates to
//! Harness Web. Recovery/Gateway control surfaces remain on-demand only.

use crate::{
    constants::{
        STARTUP_PRIMARY_RETRY_ATTEMPTS, STARTUP_RECOVERY_RETRY_ATTEMPTS, STARTUP_RETRY_DELAY_MS,
    },
    harness_window, reconciler,
    startup_trace::{self, StartupPhase},
    AppState,
};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager};

fn runtime_listener_reachable(url: &url::Url) -> bool {
    let Some(port) = url.port() else {
        return false;
    };
    let address = std::net::SocketAddr::V4(std::net::SocketAddrV4::new(
        std::net::Ipv4Addr::LOCALHOST,
        port,
    ));
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

async fn reveal_clean_runtime_fallback(app: &AppHandle) -> Result<(), String> {
    let mut stable_clean_polls = 0_usize;
    for _ in 0..STARTUP_PRIMARY_RETRY_ATTEMPTS {
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
            tokio::time::sleep(Duration::from_millis(STARTUP_RETRY_DELAY_MS)).await;
            continue;
        };
        let Some(lease) = crate::runtime::current_lease(&app.state::<AppState>()) else {
            stable_clean_polls = 0;
            tokio::time::sleep(Duration::from_millis(STARTUP_RETRY_DELAY_MS)).await;
            continue;
        };

        let clean_managed_url = window.url().ok().is_some_and(|current| {
            current.origin().ascii_serialization() == lease.origin
                && !current
                    .query_pairs()
                    .any(|(key, value)| key == "token" && !value.is_empty())
                && runtime_listener_reachable(&current)
        });
        if clean_managed_url {
            stable_clean_polls = stable_clean_polls.saturating_add(1);
        } else {
            stable_clean_polls = 0;
        }

        if stable_clean_polls >= STARTUP_RECOVERY_RETRY_ATTEMPTS {
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

        tokio::time::sleep(Duration::from_millis(STARTUP_RETRY_DELAY_MS)).await;
    }
    Ok(())
}

pub(crate) fn spawn(app: AppHandle) {
    // First paint is the actual Harness window, not a settings/control window
    // and not the separate legacy splash. This happens before any Runtime
    // filesystem work or process spawn. The local bootstrap document has no
    // Host bridge and is replaced in-place as soon as Runtime is ready.
    harness_window::hide_splash(&app);
    startup_trace::mark(StartupPhase::WebviewRequested);
    if let Err(error) = harness_window::show_harness_bootstrap(&app) {
        startup_trace::mark(StartupPhase::Recovery);
        harness_window::show_startup_recovery(&app, &error);
        return;
    }

    tauri::async_runtime::spawn(async move {
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
