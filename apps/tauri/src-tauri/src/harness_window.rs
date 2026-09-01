#[cfg(not(mobile))]
use crate::harness_shell::INIT_SCRIPT;
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
    Ok(url)
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
    #[cfg(mobile)]
    {
        let _ = (app, url);
        return Err("Android/iOS 在主 WebView 中连接 Remote Gateway，不创建桌面 Harness 窗口。".into());
    }

    #[cfg(not(mobile))]
    {
        let runtime_url = validated_runtime_url(&url)?;
        show_splash(&app, "正在打开 Harness Web…");
        if let Some(window) = app.get_webview_window("harness") {
            if let Err(error) = window.hide() {
                hide_splash(&app);
                return Err(format!("无法准备 Harness Web 界面: {error}"));
            }
            if let Err(error) = window.navigate(runtime_url) {
                hide_splash(&app);
                let _ = window.show();
                let _ = window.set_focus();
                return Err(format!("无法导航 Harness 窗口: {error}"));
            }
            if let Some(control) = app.get_webview_window("main") {
                let _ = control.hide();
            }
            return Ok(());
        }

        let _window = WebviewWindowBuilder::new(&app, "harness", WebviewUrl::External(runtime_url))
            .title("HarnessDock · DeepSeek Harness")
            .initialization_script(INIT_SCRIPT)
            // Navigation replaces the document and therefore does not rerun
            // initialization_script. Reinstall the local toolbar after every
            // completed loopback navigation so refresh/restart cannot leave a
            // blank or unmanaged WebView.
            .on_page_load(|window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = window.eval(INIT_SCRIPT);
                    let _ = window.show();
                    let _ = window.set_focus();
                    hide_splash(&window.app_handle());
                }
            })
            .inner_size(1180.0, 780.0)
            .min_inner_size(720.0, 560.0)
            .resizable(true)
            .decorations(false)
            .visible(false)
            .build()
            .map_err(|error| {
                hide_splash(&app);
                format!("无法创建 Harness WebView: {error}")
            })?;
        if let Some(control) = app.get_webview_window("main") {
            let _ = control.hide();
        }
        Ok(())
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
        let state = app.state::<crate::AppState>();
        if state.quitting.load(std::sync::atomic::Ordering::Acquire) {
            return Err("HarnessDock 正在退出，已拒绝 Web 刷新。".into());
        }
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在处理另一个操作，请稍候。".into());
        }
        let _action = WebActionGuard(&state.web_action);
        let status = crate::runtime::runtime_status(app.state());
        let url = status
            .app_url
            .ok_or_else(|| "Runtime 尚未启动，暂时无法刷新 Harness Web。".to_string())?;
        let url = validated_runtime_url(&url)?;
        show_splash(&app, "正在刷新 Harness Web…");
        let Some(window) = app.get_webview_window("harness") else {
            return harness_open(app.clone(), url.to_string()).await;
        };
        if let Err(error) = window.hide() {
            hide_splash(&app);
            return Err(format!("无法准备刷新 Harness Web 界面: {error}"));
        }
        if let Err(error) = window.navigate(url) {
            hide_splash(&app);
            let _ = window.show();
            let _ = window.set_focus();
            return Err(format!("无法导航刷新 Harness Web 界面: {error}"));
        }
        Ok(())
    }
}

/// Replace the local Runtime/Gateway and reopen the Harness WebView at the new
/// loopback URL. A failed restart returns the user to the control page instead
/// of leaving an apparently ready but disconnected WebView on screen.
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
        let state = app.state::<crate::AppState>();
        if state.web_action.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在重启，请稍候再试。".into());
        }
        let _restarting = WebActionGuard(&state.web_action);
        show_splash(&app, "正在重启 Runtime…");

        // Hide the stale WebView while its loopback Runtime is being replaced.
        // If startup fails, surface the control page from the recovery path.
        if let Some(window) = app.get_webview_window("harness") {
            if let Err(error) = window.hide() {
                hide_splash(&app);
                return Err(format!("无法暂时隐藏 Harness Web 界面: {error}"));
            }
        }

        let status = match crate::runtime::restart_managed(app.clone()).await {
            Ok(status) => status,
            Err(error) => {
                let _ = control_show(app.clone());
                return Err(error);
            }
        };
        let Some(url) = status.app_url.clone() else {
            let _ = control_show(app.clone());
            return Err("Runtime 重启成功，但没有返回 Harness Web 地址。".into());
        };
        if let Err(error) = harness_open(app.clone(), url).await {
            let _ = control_show(app.clone());
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
        crate::runtime::runtime_clear_plugin_quarantine(app.clone())?;
        harness_restart_web(app).await
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

/// The bundled control page is a hidden bootstrap/recovery surface on desktop.
/// Hiding it explicitly at boot also covers upgrades from builds that showed
/// the page by default, so the first user-visible surface is always Harness Web.
#[tauri::command]
pub fn control_hide(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(not(mobile))]
    {
        let control = app
            .get_webview_window("main")
            .ok_or_else(|| "HarnessDock 启动控制页窗口不存在。".to_string())?;
        control
            .hide()
            .map_err(|error| format!("无法隐藏 HarnessDock 启动控制页: {error}"))
    }
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
