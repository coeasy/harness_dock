//! Navigation admission: Runtime URL validation, lease-bound navigation
//! guard, load bookkeeping, watchdog and surface-operation claims.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[cfg(not(mobile))]
pub fn begin_harness_load(app: &AppHandle, runtime_generation: u64) -> Result<u64, String> {
    app.state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|mut actor| actor.begin_navigation(runtime_generation))
        .map_err(|_| lock_err("SurfaceActor"))
}

#[cfg(not(mobile))]
pub(crate) fn cancel_harness_load(app: &AppHandle) {
    if let Ok(mut actor) = app.state::<crate::AppState>().surface_actor.lock() {
        actor.cancel_navigation();
    }
}

#[cfg(mobile)]
pub(crate) fn cancel_harness_load(_app: &AppHandle) {}

pub fn validated_runtime_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Runtime URL 无效。".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("桌面 Harness WebView 只允许受管的 http://127.0.0.1:<port> Runtime。".into());
    }
    Ok(url)
}

pub fn has_launch_token(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == "token" && !value.is_empty())
}

#[cfg(not(mobile))]
pub fn is_harness_bootstrap_url(url: &Url) -> bool {
    if url.path() != "/splash.html"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }

    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    )
}

#[cfg(not(mobile))]
pub fn runtime_listener_reachable(url: &Url) -> bool {
    let Some(port) = url.port() else {
        return false;
    };
    let address = std::net::SocketAddr::V4(std::net::SocketAddrV4::new(
        std::net::Ipv4Addr::LOCALHOST,
        port,
    ));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(250)).is_ok()
}

#[cfg(not(mobile))]
pub fn current_runtime_lease(
    app: &AppHandle,
) -> Result<crate::runtime_actor::RuntimeLease, String> {
    crate::lease::require_current_lease(&app.state::<crate::AppState>())
}

#[cfg(not(mobile))]
pub fn allowed_runtime_navigation(app: &AppHandle, url: &Url) -> bool {
    let Ok(candidate) = validated_runtime_url(url.as_str()) else {
        return false;
    };
    let Ok(lease) = current_runtime_lease(app) else {
        return false;
    };
    candidate.origin().ascii_serialization() == lease.origin
}

#[cfg(not(mobile))]
pub fn allowed_harness_navigation(app: &AppHandle, url: &Url) -> bool {
    if app
        .state::<crate::AppState>()
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return false;
    }
    if is_harness_bootstrap_url(url) {
        return current_runtime_lease(app).is_err();
    }
    allowed_runtime_navigation(app, url)
}

#[cfg(not(mobile))]
pub fn finish_harness_load(window: &tauri::WebviewWindow<tauri::Wry>, loaded_url: &Url) {
    let app = window.app_handle();

    let current_matches_event = window
        .url()
        .ok()
        .map(|current| {
            current.origin() == loaded_url.origin()
                && current.path() == loaded_url.path()
                && current.query() == loaded_url.query()
        })
        .unwrap_or(false);
    if !current_matches_event {
        return;
    }

    let Ok(lease) = current_runtime_lease(app) else {
        eprintln!("Ignoring Harness page-load callback while RuntimeLease is transitioning");
        return;
    };
    let (navigation_id, navigation_generation) = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation())
        .unwrap_or((0, None));
    if navigation_generation != Some(lease.generation.id) {
        return;
    }

    let Ok(candidate) = validated_runtime_url(loaded_url.as_str()) else {
        let _ = window.hide();
        show_startup_recovery(app, "Harness Web 导航到了无效的 Runtime URL，已阻止加载。");
        return;
    };
    if candidate.origin().ascii_serialization() != lease.origin {
        let _ = window.hide();
        show_startup_recovery(app, "Harness Web 导航到了不受管理的 origin，已阻止加载。");
        return;
    }
    if !runtime_listener_reachable(&candidate) {
        let _ = window.hide();
        show_startup_recovery(
            app,
            "Harness Runtime 已发布地址，但本地 Web 监听已经失效（127.0.0.1 拒绝连接）。",
        );
        return;
    }
    if app
        .state::<crate::AppState>()
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return;
    }

    match window.eval(init_script()) {
        Ok(()) => {
            let _ = window.set_decorations(false);
            crate::startup_trace::mark(crate::startup_trace::StartupPhase::ShellReady);
        }
        Err(error) => {
            eprintln!("Unable to install Harness Shell; restoring native controls: {error}");
            let _ = window.set_decorations(true);
            crate::startup_trace::mark(crate::startup_trace::StartupPhase::NativeFallback);
        }
    }
    let accepted = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|mut actor| actor.finish_navigation(navigation_id, lease.generation.id))
        .unwrap_or(false);
    if !accepted {
        return;
    }
    if let Err(error) = window.show() {
        show_startup_recovery(app, &format!("无法显示 Harness Web 窗口: {error}"));
        return;
    }
    clear_startup_recovery(app);
    let _ = window.set_focus();
    if let Some(control) = app.get_webview_window("control") {
        let _ = control.close();
    }
    hide_splash(app);
    crate::startup_trace::mark(crate::startup_trace::StartupPhase::PrimaryVisible);
}

#[cfg(not(mobile))]
pub fn schedule_harness_watchdog(app: &AppHandle, navigation_id: u64, runtime_generation: u64) {
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_secs(20));
        })
        .await;
        if watchdog_app
            .state::<crate::AppState>()
            .quitting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        let should_fail = watchdog_app
            .state::<crate::AppState>()
            .surface_actor
            .lock()
            .map(|mut actor| {
                actor.phase() == SurfacePhase::Loading
                    && actor.fail_navigation(navigation_id, runtime_generation)
            })
            .unwrap_or(false);
        if !should_fail {
            return;
        }
        if let Some(window) = watchdog_app.get_webview_window("harness") {
            let _ = window.hide();
        }
        show_startup_recovery(
            &watchdog_app,
            "Harness Web 在 20 秒内没有完成当前 generation/navigation 加载。",
        );
    });
}

pub struct SurfaceOperationGuard(AppHandle);

impl Drop for SurfaceOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut actor) = self.0.state::<crate::AppState>().surface_actor.lock() {
            actor.end_operation();
        }
    }
}

#[cfg(not(mobile))]
pub fn claim_surface_operation(
    app: &AppHandle,
    operation: SurfaceOperation,
) -> Result<SurfaceOperationGuard, String> {
    if app
        .state::<crate::AppState>()
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("HarnessDock 正在退出，已拒绝新的界面操作。".into());
    }
    app.state::<crate::AppState>()
        .surface_actor
        .lock()
        .map_err(|_| lock_err("SurfaceActor"))?
        .begin_operation(operation)?;
    Ok(SurfaceOperationGuard(app.clone()))
}
