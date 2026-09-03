#[cfg(not(mobile))]
use crate::harness_shell::init_script;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::Url;

#[cfg(not(mobile))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::surface_actor::{SurfaceOperation, SurfacePhase};

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
fn set_control_surface(window: &tauri::WebviewWindow<tauri::Wry>, mode: &str, error: Option<&str>) {
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
fn show_control_surface(app: &AppHandle, mode: &str, error: Option<&str>) -> Result<(), String> {
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
    if let Ok(mut surface) = state.surface_actor.lock() {
        let (navigation, generation) = surface.current_navigation();
        if let Some(generation) = generation {
            let _ = surface.fail_navigation(navigation, generation);
        }
        surface.end_operation();
    }
    eprintln!("HarnessDock startup failed: {error}");
    if let Err(surface_error) = show_control_surface(app, "recovery", Some(error)) {
        eprintln!("HarnessDock recovery surface unavailable: {surface_error}");
    }
}

fn clear_startup_recovery(app: &AppHandle) {
    if let Ok(mut recovery) = app.state::<crate::AppState>().startup_recovery_error.lock() {
        *recovery = None;
    }
}

#[cfg(not(mobile))]
fn begin_harness_load(app: &AppHandle, runtime_generation: u64) -> Result<u64, String> {
    app.state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|mut actor| actor.begin_navigation(runtime_generation))
        .map_err(|_| "SurfaceActor 状态锁已损坏。".to_string())
}

#[cfg(not(mobile))]
pub(crate) fn cancel_harness_load(app: &AppHandle) {
    if let Ok(mut actor) = app.state::<crate::AppState>().surface_actor.lock() {
        actor.cancel_navigation();
    }
}

#[cfg(mobile)]
pub(crate) fn cancel_harness_load(_app: &AppHandle) {}

fn validated_runtime_url(value: &str) -> Result<Url, String> {
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

fn has_launch_token(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == "token" && !value.is_empty())
}

#[cfg(not(mobile))]
fn current_runtime_lease(app: &AppHandle) -> Result<crate::runtime_actor::RuntimeLease, String> {
    crate::runtime::live_lease(&*app.state::<crate::AppState>())
        .ok_or_else(|| "Runtime 尚未就绪，暂时无法打开 Harness Web。".to_string())
}

#[cfg(not(mobile))]
fn allowed_runtime_navigation(app: &AppHandle, url: &Url) -> bool {
    let Ok(candidate) = validated_runtime_url(url.as_str()) else {
        return false;
    };
    let Ok(lease) = current_runtime_lease(app) else {
        return false;
    };
    candidate.origin().ascii_serialization() == lease.origin
}

#[cfg(not(mobile))]
fn finish_harness_load(window: &tauri::WebviewWindow<tauri::Wry>, loaded_url: &Url) {
    let app = window.app_handle();
    let Ok(lease) = current_runtime_lease(&app) else {
        let _ = window.hide();
        show_startup_recovery(&app, "Harness Web 加载完成时 RuntimeLease 已失效。");
        return;
    };
    if !allowed_runtime_navigation(&app, loaded_url) {
        let _ = window.hide();
        show_startup_recovery(&app, "Harness Web 导航到了不受管理的 origin，已阻止加载。");
        return;
    }
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
    let (navigation_id, navigation_generation) = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation())
        .unwrap_or((0, None));
    if navigation_generation != Some(lease.generation.id) {
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
        show_startup_recovery(&app, &format!("无法显示 Harness Web 窗口: {error}"));
        return;
    }
    clear_startup_recovery(&app);
    let _ = window.set_focus();
    if let Some(control) = app.get_webview_window("control") {
        let _ = control.close();
    }
    hide_splash(&app);
    crate::startup_trace::mark(crate::startup_trace::StartupPhase::PrimaryVisible);
}

#[cfg(not(mobile))]
fn schedule_harness_watchdog(app: &AppHandle, navigation_id: u64, runtime_generation: u64) {
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

struct SurfaceOperationGuard(AppHandle);

impl Drop for SurfaceOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut actor) = self.0.state::<crate::AppState>().surface_actor.lock() {
            actor.end_operation();
        }
    }
}

#[cfg(not(mobile))]
fn claim_surface_operation(app: &AppHandle, operation: SurfaceOperation) -> Result<SurfaceOperationGuard, String> {
    app.state::<crate::AppState>()
        .surface_actor
        .lock()
        .map_err(|_| "SurfaceActor 状态锁已损坏。".to_string())?
        .begin_operation(operation)?;
    Ok(SurfaceOperationGuard(app.clone()))
}

#[tauri::command]
pub async fn harness_open(app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, url);
        return Err("Android/iOS 使用 Remote Gateway，不创建桌面 Harness 窗口。".into());
    }

    #[cfg(not(mobile))]
    {
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
                && current_url.as_ref().is_some_and(|current| !has_launch_token(current))
            {
                let _ = window.show();
                let _ = window.set_focus();
                hide_splash(&app);
                return Ok(());
            }
            let navigation_id = begin_harness_load(&app, lease.generation.id)?;
            show_splash(&app, "正在打开 Harness Web…");
            let result = if same_origin
                && current_url.as_ref().is_some_and(|current| !has_launch_token(current))
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
        show_splash(&app, "正在打开 Harness Web…");
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
}

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
        let navigation_id = begin_harness_load(&app, lease.generation.id)?;
        show_splash(&app, "正在刷新 Harness Web…");
        let result = if current
            .as_ref()
            .is_some_and(|value| value.origin().ascii_serialization() == lease.origin && !has_launch_token(value))
        {
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

#[cfg(not(mobile))]
async fn restart_harness_web_impl(
    app: AppHandle,
    clear_quarantine: bool,
    safe_mode: bool,
) -> Result<crate::runtime::RuntimeStatus, String> {
    show_splash(
        &app,
        if safe_mode {
            "正在以隔离插件模式重启…"
        } else if clear_quarantine {
            "正在清除插件隔离并重启…"
        } else {
            "正在重启 Runtime…"
        },
    );
    cancel_harness_load(&app);
    let reopen_epoch = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation().0)
        .unwrap_or_default();
    if let Some(window) = app.get_webview_window("harness") {
        let _ = window.hide();
    }
    if clear_quarantine {
        crate::runtime::runtime_clear_plugin_quarantine(app.clone()).map_err(|error| {
            show_startup_recovery(&app, &error);
            error
        })?;
    }
    let status = if safe_mode {
        crate::runtime::restart_managed_safe(app.clone()).await
    } else {
        crate::runtime::restart_managed(app.clone()).await
    }
    .map_err(|error| {
        show_startup_recovery(&app, &error);
        error
    })?;
    let current_epoch = app
        .state::<crate::AppState>()
        .surface_actor
        .lock()
        .map(|actor| actor.current_navigation().0)
        .unwrap_or_default();
    if current_epoch != reopen_epoch {
        hide_splash(&app);
        return Ok(status);
    }
    let Some(url) = status.app_url.clone() else {
        let error = "Runtime 重启后没有返回 Harness Web 地址。".to_string();
        show_startup_recovery(&app, &error);
        return Err(error);
    };
    harness_open(app.clone(), url).await.map_err(|error| {
        show_startup_recovery(&app, &error);
        error
    })?;
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
        let _operation = claim_surface_operation(&app, SurfaceOperation::Restart)?;
        restart_harness_web_impl(app, false, false).await
    }
}

#[tauri::command]
pub async fn harness_safe_mode_restart(app: AppHandle) -> Result<crate::runtime::RuntimeStatus, String> {
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
pub async fn harness_clear_quarantine_restart(app: AppHandle) -> Result<crate::runtime::RuntimeStatus, String> {
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
fn harness_window(app: &AppHandle) -> Result<tauri::WebviewWindow<tauri::Wry>, String> {
    app.get_webview_window("harness")
        .ok_or_else(|| "Harness Web 窗口尚未创建。".to_string())
}

#[tauri::command]
pub fn harness_minimize(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    { let _ = app; Ok(()) }
    #[cfg(not(mobile))]
    { harness_window(&app)?.minimize().map_err(|error| format!("无法最小化 Harness 窗口: {error}")) }
}

#[tauri::command]
pub fn harness_toggle_maximize(app: AppHandle) -> Result<HarnessWindowState, String> {
    #[cfg(mobile)]
    { let _ = app; Ok(HarnessWindowState { maximized: false }) }
    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())?;
        } else {
            window.maximize().map_err(|error| error.to_string())?;
        }
        Ok(HarnessWindowState { maximized: window.is_maximized().unwrap_or(false) })
    }
}

#[tauri::command]
pub fn harness_window_state(app: AppHandle) -> Result<HarnessWindowState, String> {
    #[cfg(mobile)]
    { let _ = app; Ok(HarnessWindowState { maximized: false }) }
    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        Ok(HarnessWindowState { maximized: window.is_maximized().unwrap_or(false) })
    }
}

#[tauri::command]
pub fn control_show(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    { let _ = app; Ok(()) }
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
    { let _ = (app, status); Ok(()) }
    #[cfg(not(mobile))]
    { set_splash_status(&app, &status); Ok(()) }
}

#[tauri::command]
pub fn startup_recovery_status(app: AppHandle) -> Result<Option<String>, String> {
    app.state::<crate::AppState>()
        .startup_recovery_error
        .lock()
        .map(|recovery| recovery.clone())
        .map_err(|_| "启动恢复状态锁已损坏。".to_string())
}

#[cfg(not(mobile))]
async fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| format!("无法显示插件诊断窗口: {error}"))?;
        window.set_focus().map_err(|error| format!("无法聚焦插件诊断窗口: {error}"))?;
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
    { let _ = app; Err("移动端不提供桌面插件诊断窗口。".into()) }
    #[cfg(not(mobile))]
    {
        let _operation = claim_surface_operation(&app, SurfaceOperation::Diagnostics)?;
        show_settings_window(&app).await
    }
}

#[cfg(test)]
mod tests {
    use super::{has_launch_token, validated_runtime_url};

    #[test]
    fn runtime_url_matches_the_exact_loopback_capability_boundary() {
        assert!(validated_runtime_url("http://127.0.0.1:4321/").is_ok());
        assert!(validated_runtime_url("https://localhost:4321/").is_err());
        assert!(validated_runtime_url("http://localhost:4321/").is_err());
        assert!(validated_runtime_url("http://example.com:4321/").is_err());
    }

    #[test]
    fn only_nonempty_token_is_launch_credential() {
        assert!(has_launch_token(&validated_runtime_url("http://127.0.0.1:4321/?token=x").unwrap()));
        assert!(!has_launch_token(&validated_runtime_url("http://127.0.0.1:4321/?tab=plugins").unwrap()));
    }
}
