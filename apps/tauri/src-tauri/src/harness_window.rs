#[cfg(not(mobile))]
use crate::harness_shell::init_script;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::Url;

#[cfg(not(mobile))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(not(mobile))]
pub(crate) fn hide_splash(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.hide();
    }
}

#[cfg(mobile)]
pub(crate) fn hide_splash(_app: &AppHandle) {}

#[cfg(not(mobile))]
fn set_splash_status(app: &AppHandle, status: &str) {
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

#[cfg(not(mobile))]
fn show_control_recovery(app: &AppHandle, error: &str) {
    hide_splash(app);
    let Some(control) = app.get_webview_window("main") else {
        eprintln!("HarnessDock startup recovery window is unavailable: {error}");
        return;
    };

    let _ = control.show();
    let _ = control.set_focus();
    if let Ok(value) = serde_json::to_string(error) {
        // The helper is installed by the bundled recovery page. It is
        // intentionally best-effort: showing the page is more important than
        // making an error notification scriptable.
        let _ = control.eval(format!("window.__harnessDockShowRecovery?.({value})"));
    }
}

#[cfg(not(mobile))]
pub(crate) fn show_startup_recovery(app: &AppHandle, error: &str) {
    let state = app.state::<crate::AppState>();
    state
        .harness_loading
        .store(false, std::sync::atomic::Ordering::Release);
    if let Ok(mut recovery) = state.startup_recovery_error.lock() {
        *recovery = Some(error.to_string());
    }
    eprintln!("HarnessDock startup failed: {error}");
    show_control_recovery(app, error);
}

fn clear_startup_recovery(app: &AppHandle) {
    if let Ok(mut recovery) = app.state::<crate::AppState>().startup_recovery_error.lock() {
        *recovery = None;
    }
}

#[cfg(not(mobile))]
fn begin_harness_load(state: &crate::AppState) -> u64 {
    state
        .harness_load_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
        .wrapping_add(1)
}

#[cfg(not(mobile))]
pub(crate) fn cancel_harness_load(app: &AppHandle) {
    let state = app.state::<crate::AppState>();
    state
        .harness_load_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    state
        .harness_loading
        .store(false, std::sync::atomic::Ordering::Release);
}

#[cfg(mobile)]
pub(crate) fn cancel_harness_load(_app: &AppHandle) {}

#[cfg(not(mobile))]
fn allowed_runtime_navigation(app: &AppHandle, url: &Url) -> bool {
    let Ok(candidate) = validated_runtime_url(url.as_str()) else {
        return false;
    };
    let status = crate::runtime::status_snapshot(&*app.state::<crate::AppState>());
    let Some(expected) = status
        .app_url
        .as_deref()
        .and_then(|value| validated_runtime_url(value).ok())
    else {
        return false;
    };
    candidate.origin() == expected.origin()
}

#[cfg(not(mobile))]
fn finish_harness_load(window: &tauri::WebviewWindow<tauri::Wry>, loaded_url: &Url) {
    let app = window.app_handle();
    let state = app.state::<crate::AppState>();
    let navigation_allowed = allowed_runtime_navigation(&app, loaded_url);
    let current_matches_event = window
        .url()
        .ok()
        .map(|current| {
            current.origin() == loaded_url.origin()
                && current.path() == loaded_url.path()
                && current.query() == loaded_url.query()
        })
        .unwrap_or(true);
    if !navigation_allowed {
        if state
            .harness_loading
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            let _ = window.hide();
            show_startup_recovery(
                &app,
                "Harness Web 导航到了不受管理的本地页面，已阻止加载。\n请重试打开 Harness。",
            );
        }
        return;
    }
    if !current_matches_event {
        // A previous navigation can deliver Finished after a newer reload or
        // restart has already replaced the document. It is a stale callback,
        // not evidence that the current managed navigation failed; leave the
        // current loading generation and watchdog untouched.
        return;
    }
    if state
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
        || !state
            .harness_loading
            .swap(false, std::sync::atomic::Ordering::AcqRel)
    {
        // A Finished callback can arrive after the user closes the window (or
        // after shutdown has begun). It must never resurrect the primary Web
        // surface after that explicit intent.
        return;
    }
    if let Err(error) = window.eval(init_script()) {
        // The Harness document remains the primary surface even if a best-
        // effort toolbar injection is rejected by a WebView implementation.
        // Menu and native commands remain available for a later retry.
        eprintln!("Unable to install Harness Shell; continuing with Harness Web: {error}");
    }
    if let Err(error) = window.show() {
        let _ = window.hide();
        show_startup_recovery(&app, &format!("无法显示 Harness Web 窗口: {error}"));
        return;
    }
    clear_startup_recovery(&app);
    let _ = window.set_focus();
    if let Some(control) = app.get_webview_window("main") {
        let _ = control.hide();
    }
    hide_splash(&app);
}

#[cfg(not(mobile))]
fn schedule_harness_watchdog(app: &AppHandle, generation: u64) {
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_secs(20));
        })
        .await;
        let state = watchdog_app.state::<crate::AppState>();
        if state.quitting.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        if state
            .harness_load_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
        {
            return;
        }
        if !state
            .harness_loading
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        let Some(window) = watchdog_app.get_webview_window("harness") else {
            return;
        };
        if state
            .harness_loading
            .compare_exchange(
                true,
                false,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
        {
            let _ = window.hide();
            show_startup_recovery(
                &watchdog_app,
                "Harness Web 在 20 秒内没有完成加载。Runtime 仍可诊断，请重试打开 Harness。",
            );
        }
    });
}

fn validated_runtime_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Runtime URL 无效。".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Runtime WebView 只允许 HTTP(S)。".into());
    }
    let host = url.host_str().ok_or_else(|| "Runtime URL 缺少主机名。".to_string())?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    if !loopback {
        return Err("桌面 Harness WebView 只允许本地 loopback Runtime。".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Runtime URL 不能包含用户名或密码。".into());
    }
    Ok(url)
}

/// dsh 0.1.2+ uses a reusable `?token=...` process-launch credential. Ordinary
/// same-origin application queries are not launch credentials and must survive
/// reload/recovery instead of forcing navigation back to Runtime's start URL.
fn has_launch_token(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == "token" && !value.is_empty())
}

struct WebActionGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for WebActionGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

struct SettingsOpenGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for SettingsOpenGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(not(mobile))]
fn hide_harness_for_recovery(window: &tauri::WebviewWindow<tauri::Wry>) {
    let _ = window.hide();
}

#[cfg(not(mobile))]
async fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| format!("无法显示插件诊断窗口: {error}"))?;
        window.set_focus().map_err(|error| format!("无法聚焦插件诊断窗口: {error}"))?;
        return Ok(());
    }

    let _window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("HarnessDock · 插件诊断")
    .inner_size(560.0, 520.0)
    .min_inner_size(480.0, 420.0)
    .resizable(true)
    .center()
    // Window creation must stay inside an async command on Windows. Keeping
    // the page hidden until the native window exists also prevents a half-built
    // settings surface from flashing during startup.
    .visible(false)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            // Do not expose an unpainted WebView. The settings plugin becomes
            // visible only after its HTML/CSS/JS document has finished loading.
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    .map_err(|error| format!("无法创建插件诊断窗口: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn harness_open(app: AppHandle, url: String) -> Result<(), String> {
    if app
        .state::<crate::AppState>()
        .quitting
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("HarnessDock 正在退出，已拒绝打开 Harness Web。".into());
    }

    #[cfg(mobile)]
    {
        let _ = (app, url);
        return Err("Android/iOS 在主 WebView 中连接 Remote Gateway，不创建桌面 Harness 窗口。".into());
    }

    #[cfg(not(mobile))]
    {
        let runtime_url = validated_runtime_url(&url)?;
        let state_app = app.clone();
        let state = state_app.state::<crate::AppState>();
        let current = crate::runtime::status_snapshot(&*state);
        let expected = current
            .app_url
            .as_deref()
            .ok_or_else(|| "Runtime 尚未启动，暂时无法打开 Harness Web。".to_string())
            .and_then(validated_runtime_url)?;
        if runtime_url.origin() != expected.origin() {
            return Err("Harness Web URL 与当前受管 Runtime 不一致，已拒绝导航。".into());
        }
        if let Some(window) = app.get_webview_window("harness") {
            let loading = state
                .harness_loading
                .load(std::sync::atomic::Ordering::Acquire);
            let current_url = window
                .url()
                .ok()
                .and_then(|current| validated_runtime_url(current.as_str()).ok());
            let current_matches = current_url
                .as_ref()
                .is_some_and(|current| current.origin() == expected.origin());
            if current_matches {
                let current_has_launch_token = current_url.as_ref().is_some_and(has_launch_token);
                if loading {
                    // A second open request must not create a new generation
                    // while the first WebView navigation is still exchanging
                    // its reusable process launch token. Keep the splash/watchdog that
                    // belongs to the in-flight request intact.
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.set_focus();
                    }
                    if let Some(control) = app.get_webview_window("main") {
                        let _ = control.hide();
                    }
                    return Ok(());
                }
                if !current_has_launch_token {
                    let recovery_pending = state
                        .startup_recovery_error
                        .lock()
                        .map(|recovery| recovery.is_some())
                        .unwrap_or(true);
                    if !recovery_pending {
                        let _ = window.show();
                        let _ = window.set_focus();
                        if let Some(control) = app.get_webview_window("main") {
                            let _ = control.hide();
                        }
                        hide_splash(&app);
                        return Ok(());
                    }
                    // A previous page-load callback may have failed after the
                    // document was already authenticated. Reload that same
                    // cookie-bearing URL instead of relying on the process
                    // launch token returned by Runtime; the finished hook will
                    // reinstall the shell and clear recovery state.
                    let generation = begin_harness_load(&*state);
                    state
                        .harness_loading
                        .store(true, std::sync::atomic::Ordering::Release);
                    show_splash(&app, "正在恢复 Harness Web…");
                    if let Err(error) = window.reload() {
                        state
                            .harness_loading
                            .store(false, std::sync::atomic::Ordering::Release);
                        hide_harness_for_recovery(&window);
                        show_startup_recovery(&app, &format!("无法恢复 Harness Web: {error}"));
                        return Err(format!("无法恢复 Harness Web: {error}"));
                    }
                    if let Some(control) = app.get_webview_window("main") {
                        let _ = control.hide();
                    }
                    schedule_harness_watchdog(&app, generation);
                    return Ok(());
                }
            }

            let generation = begin_harness_load(&*state);
            state
                .harness_loading
                .store(true, std::sync::atomic::Ordering::Release);
            show_splash(&app, "正在打开 Harness Web…");
            if let Err(error) = window.navigate(runtime_url) {
                app.state::<crate::AppState>()
                    .harness_loading
                    .store(false, std::sync::atomic::Ordering::Release);
                hide_harness_for_recovery(&window);
                show_startup_recovery(&app, &format!("无法导航 Harness 窗口: {error}"));
                return Err(format!("无法导航 Harness 窗口: {error}"));
            }
            if let Some(control) = app.get_webview_window("main") {
                let _ = control.hide();
            }
            schedule_harness_watchdog(&app, generation);
            return Ok(());
        }

        let generation = begin_harness_load(&*state);
        state
            .harness_loading
            .store(true, std::sync::atomic::Ordering::Release);
        show_splash(&app, "正在打开 Harness Web…");
        let navigation_app = app.clone();
        let _window = WebviewWindowBuilder::new(&app, "harness", WebviewUrl::External(runtime_url))
            .title("HarnessDock · DeepSeek Harness")
            .initialization_script(init_script())
            // The Harness page is allowed to navigate within the current
            // managed Runtime origin, but it must never turn the privileged
            // shell WebView into a bridge for another local service.
            .on_navigation(move |url| allowed_runtime_navigation(&navigation_app, url))
            // Navigation replaces the document and therefore does not rerun
            // initialization_script. Reinstall the local toolbar after every
            // completed loopback navigation so refresh/restart cannot leave a
            // blank or unmanaged WebView.
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
            .build()
            .map_err(|error| {
                app.state::<crate::AppState>()
                    .harness_loading
                    .store(false, std::sync::atomic::Ordering::Release);
                show_startup_recovery(&app, &format!("无法创建 Harness WebView: {error}"));
                format!("无法创建 Harness WebView: {error}")
            })?;
        if let Some(control) = app.get_webview_window("main") {
            let _ = control.hide();
        }
        schedule_harness_watchdog(&app, generation);
        Ok(())
    }
}

/// Native startup uses the same guarded window path as the recovery page, but
/// keeps the responsibility out of the hidden bootstrap renderer.
pub(crate) async fn open_for_startup(app: AppHandle, url: String) -> Result<(), String> {
    harness_open(app, url).await
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
            window.hide().map_err(|error| format!("无法隐藏 Harness 窗口: {error}"))?;
        }
        Ok(())
    }
}

/// Reload the Harness document without replacing the Runtime or Gateway. A
/// native navigation is used instead of a renderer-side reload call: the former
/// is observable by Tauri and lets the page-load hook reinstall the toolbar.
#[tauri::command]
pub async fn harness_reload_web(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("移动端不提供桌面 Harness WebView 刷新命令。".into());
    }

    #[cfg(not(mobile))]
    {
        let state_app = app.clone();
        let state = state_app.state::<crate::AppState>();
        if state.quitting.load(std::sync::atomic::Ordering::Acquire) {
            return Err("HarnessDock 正在退出，已拒绝 Web 刷新。".into());
        }
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在处理另一个操作，请稍候。".into());
        }
        let _action = WebActionGuard(&state.web_action);
        let status = crate::runtime::status_snapshot(&*state);
        let url = status
            .app_url
            .ok_or_else(|| "Runtime 尚未启动，暂时无法刷新 Harness Web。".to_string())?;
        let url = validated_runtime_url(&url)?;
        let Some(window) = app.get_webview_window("harness") else {
            let result = harness_open(app.clone(), url.to_string()).await;
            if result.is_err() {
                hide_splash(&app);
            }
            return result;
        };
        if state
            .harness_loading
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Harness Web 正在加载，请稍候再试。".into());
        }
        show_splash(&app, "正在刷新 Harness Web…");
        // Keep the current document visible while the next document loads.
        // Hiding first creates the blank-window failure mode users see when
        // WebView navigation is slow or a renderer misses its load callback.
        // The splash/progress surface still communicates that navigation is
        // in progress, and the page-load hook restores focus after success.
        let current_url = window
            .url()
            .ok()
            .and_then(|current| validated_runtime_url(current.as_str()).ok());
        let same_runtime_origin = current_url
            .as_ref()
            .is_some_and(|current| current.origin() == url.origin());
        let generation = begin_harness_load(&*state);
        state
            .harness_loading
            .store(true, std::sync::atomic::Ordering::Release);
        let result = if same_runtime_origin
            && current_url
                .as_ref()
                .is_some_and(|current| !has_launch_token(current))
        {
            window.reload()
        } else {
            window.navigate(url)
        };
        if let Err(error) = result {
            app.state::<crate::AppState>()
                .harness_loading
                .store(false, std::sync::atomic::Ordering::Release);
            hide_harness_for_recovery(&window);
            show_startup_recovery(&app, &format!("无法刷新 Harness Web 界面: {error}"));
            return Err(format!("无法刷新 Harness Web 界面: {error}"));
        }
        schedule_harness_watchdog(&app, generation);
        Ok(())
    }
}

/// Replace the local Runtime/Gateway and reopen the Harness WebView at the new
/// loopback URL. A failed restart returns the user to the recovery surface
/// instead of leaving an apparently ready but disconnected WebView on screen.
#[cfg(not(mobile))]
async fn restart_harness_web_impl(
    app: AppHandle,
    clear_quarantine: bool,
) -> Result<crate::runtime::RuntimeStatus, String> {
    let state = app.state::<crate::AppState>();
    show_splash(
        &app,
        if clear_quarantine {
            "正在清除插件隔离并重启…"
        } else {
            "正在重启 Runtime…"
        },
    );

    // Capture the generation before any longer operation. A concurrent close
    // increments it, so the completed restart cannot resurrect a window the
    // user explicitly hid while quarantine cleanup or Runtime startup ran.
    let reopen_generation = {
        let mut generation = state
            .harness_load_generation
            .load(std::sync::atomic::Ordering::Acquire);
        if let Some(window) = app.get_webview_window("harness") {
            cancel_harness_load(&app);
            generation = state
                .harness_load_generation
                .load(std::sync::atomic::Ordering::Acquire);
            if let Err(error) = window.hide() {
                hide_splash(&app);
                return Err(format!("无法暂时隐藏 Harness Web 界面: {error}"));
            }
        }
        generation
    };

    if clear_quarantine {
        if let Err(error) = crate::runtime::runtime_clear_plugin_quarantine(app.clone()) {
            hide_splash(&app);
            return Err(error);
        }
    }

    let status = match crate::runtime::restart_managed(app.clone()).await {
        Ok(status) => status,
        Err(error) => {
            show_startup_recovery(&app, &error);
            return Err(error);
        }
    };
    let Some(url) = status.app_url.clone() else {
        show_startup_recovery(
            &app,
            "Runtime 重启成功，但没有返回 Harness Web 地址。",
        );
        return Err("Runtime 重启成功，但没有返回 Harness Web 地址。".into());
    };
    if state
        .harness_load_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != reopen_generation
    {
        // A close/hide request arrived while Runtime was restarting. Keep
        // that explicit user intent; do not resurrect the WebView after the
        // operation completes.
        hide_splash(&app);
        return Ok(status);
    }
    if let Err(error) = harness_open(app.clone(), url).await {
        show_startup_recovery(&app, &error);
        return Err(error);
    }
    Ok(status)
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
        if app
            .state::<crate::AppState>()
            .quitting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("HarnessDock 正在退出，已拒绝 Web 重启。".into());
        }
        let state_app = app.clone();
        let state = state_app.state::<crate::AppState>();
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在重启，请稍候再试。".into());
        }
        let _restarting = WebActionGuard(&state.web_action);
        restart_harness_web_impl(app, false).await
    }
}

/// Explicitly start a clean temporary DSH_HOME and reopen Harness Web. The
/// user's plugin configuration is not changed and the normal Web surface stays
/// the only visible application page when this succeeds.
#[tauri::command]
pub async fn harness_safe_mode_restart(app: AppHandle) -> Result<crate::runtime::RuntimeStatus, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 使用 Remote Gateway，不支持桌面隔离插件启动。".into());
    }

    #[cfg(not(mobile))]
    {
        if app
            .state::<crate::AppState>()
            .quitting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("HarnessDock 正在退出，已拒绝隔离插件启动。".into());
        }
        let state = app.state::<crate::AppState>();
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在重启，请稍候再试。".into());
        }
        let _restarting = WebActionGuard(&state.web_action);
        show_splash(&app, "正在以隔离插件模式启动…");
        let reopen_generation = {
            let mut generation = state
                .harness_load_generation
                .load(std::sync::atomic::Ordering::Acquire);
            if let Some(window) = app.get_webview_window("harness") {
                cancel_harness_load(&app);
                generation = state
                    .harness_load_generation
                    .load(std::sync::atomic::Ordering::Acquire);
                if let Err(error) = window.hide() {
                    hide_splash(&app);
                    return Err(format!("无法暂时隐藏 Harness Web 界面: {error}"));
                }
            }
            generation
        };

        let status = match crate::runtime::restart_managed_safe(app.clone()).await {
            Ok(status) => status,
            Err(error) => {
                show_startup_recovery(&app, &error);
                return Err(error);
            }
        };
        let Some(url) = status.app_url.clone() else {
            show_startup_recovery(&app, "隔离插件启动成功，但没有返回 Harness Web 地址。");
            return Err("隔离插件启动成功，但没有返回 Harness Web 地址。".into());
        };
        if state
            .harness_load_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != reopen_generation
        {
            hide_splash(&app);
            return Ok(status);
        }
        if let Err(error) = harness_open(app.clone(), url).await {
            show_startup_recovery(&app, &error);
            return Err(error);
        }
        Ok(status)
    }
}

/// Clear the persisted plugin quarantine and perform the same guarded Runtime
/// restart as the normal Web action. Keeping this as one native command makes
/// the primary Web shell able to offer an explicit recovery action without
/// granting it the lower-level quarantine storage permission.
#[tauri::command]
pub async fn harness_clear_quarantine_restart(
    app: AppHandle,
) -> Result<crate::runtime::RuntimeStatus, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 使用 Remote Gateway，不支持桌面插件隔离恢复。".into());
    }

    #[cfg(not(mobile))]
    {
        if app
            .state::<crate::AppState>()
            .quitting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("HarnessDock 正在退出，已拒绝插件隔离恢复。".into());
        }
        let state_app = app.clone();
        let state = state_app.state::<crate::AppState>();
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在重启，请稍候再试。".into());
        }
        let _restarting = WebActionGuard(&state.web_action);
        restart_harness_web_impl(app, true).await
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) -> Result<(), String> {
    crate::request_exit(&app);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessWindowState {
    pub maximized: bool,
}

#[cfg(not(mobile))]
fn harness_window(app: &AppHandle) -> Result<tauri::WebviewWindow<tauri::Wry>, String> {
    app.get_webview_window("harness")
        .ok_or_else(|| "Harness Web 窗口尚未创建。".to_string())
}

#[tauri::command]
pub fn harness_minimize(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(not(mobile))]
    {
        harness_window(&app)?.minimize().map_err(|error| format!("无法最小化 Harness 窗口: {error}"))
    }
}

#[tauri::command]
pub fn harness_toggle_maximize(app: AppHandle) -> Result<HarnessWindowState, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(HarnessWindowState { maximized: false });
    }

    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        if window.is_maximized().map_err(|error| format!("无法读取 Harness 窗口状态: {error}"))? {
            window.unmaximize().map_err(|error| format!("无法还原 Harness 窗口: {error}"))?;
        } else {
            window.maximize().map_err(|error| format!("无法最大化 Harness 窗口: {error}"))?;
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
        return Ok(HarnessWindowState { maximized: false });
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
        return Ok(());
    }

    #[cfg(not(mobile))]
    {
        hide_splash(&app);
        let control = app
            .get_webview_window("main")
            .ok_or_else(|| "HarnessDock 控制页窗口不存在。".to_string())?;
        control
            .show()
            .map_err(|error| format!("无法显示 HarnessDock 控制页: {error}"))?;
        control
            .set_focus()
            .map_err(|error| format!("无法聚焦 HarnessDock 控制页: {error}"))?;
        Ok(())
    }
}

/// Update the desktop-only startup splash without making splash failures block
/// Runtime startup. The splash has no remote permissions and this command is
/// available only to the hidden local bootstrap window.
#[tauri::command]
pub fn splash_status(app: AppHandle, status: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, status);
        return Ok(());
    }

    #[cfg(not(mobile))]
    {
        set_splash_status(&app, &status);
        Ok(())
    }
}

/// Read a startup error that may have occurred before the hidden control page
/// finished loading. Keeping the error in native state closes the recovery-page
/// timing gap without exposing it to the remote Harness WebView.
#[tauri::command]
pub fn startup_recovery_status(app: AppHandle) -> Result<Option<String>, String> {
    app.state::<crate::AppState>()
        .startup_recovery_error
        .lock()
        .map(|recovery| recovery.clone())
        .map_err(|_| "启动恢复状态锁已损坏。".to_string())
}

#[tauri::command]
pub async fn shell_settings_show(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("移动端不提供桌面插件诊断窗口。".into());
    }

    #[cfg(not(mobile))]
    {
        let state = app.state::<crate::AppState>();
        if state
            .settings_opening
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err("插件诊断窗口正在打开，请稍候。".into());
        }
        let _opening = SettingsOpenGuard(&state.settings_opening);
        show_settings_window(&app).await
    }
}

#[tauri::command]
pub fn shell_settings_close(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(not(mobile))]
    {
        if let Some(window) = app.get_webview_window("settings") {
            window.hide().map_err(|error| format!("无法隐藏插件诊断窗口: {error}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{has_launch_token, validated_runtime_url};

    #[test]
    fn only_explicit_nonempty_token_query_is_a_launch_credential() {
        let clean = validated_runtime_url("http://127.0.0.1:4321/").unwrap();
        let ordinary = validated_runtime_url("http://127.0.0.1:4321/?tab=plugins&view=compact").unwrap();
        let launch = validated_runtime_url("http://127.0.0.1:4321/?token=abc123").unwrap();
        let mixed = validated_runtime_url("http://127.0.0.1:4321/?view=compact&token=abc123").unwrap();
        let empty = validated_runtime_url("http://127.0.0.1:4321/?token=&view=compact").unwrap();

        assert!(!has_launch_token(&clean));
        assert!(!has_launch_token(&ordinary));
        assert!(has_launch_token(&launch));
        assert!(has_launch_token(&mixed));
        assert!(!has_launch_token(&empty));
    }
}