#[cfg(not(mobile))]
use crate::harness_shell::INIT_SCRIPT;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::Url;

#[cfg(not(mobile))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

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

struct WebRestartGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for WebRestartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(not(mobile))]
fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| format!("无法显示外壳设置插件: {error}"))?;
        window.set_focus().map_err(|error| format!("无法聚焦外壳设置插件: {error}"))?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("HarnessDock · 外壳设置")
    .inner_size(760.0, 650.0)
    .min_inner_size(560.0, 480.0)
    .resizable(true)
    .build()
    .map_err(|error| format!("无法创建外壳设置插件窗口: {error}"))?;
    window
        .show()
        .map_err(|error| format!("无法显示外壳设置插件: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦外壳设置插件: {error}"))?;
    Ok(())
}

#[cfg(not(mobile))]
pub fn prewarm_settings_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("settings").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("HarnessDock · 外壳设置")
        .inner_size(760.0, 650.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .visible(false)
        .build()
        .map(|_| ())
        .map_err(|error| format!("无法预热外壳设置插件窗口: {error}"))
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
        if let Some(window) = app.get_webview_window("harness") {
            window
                .navigate(runtime_url)
                .map_err(|error| format!("无法导航 Harness 窗口: {error}"))?;
            window.show().map_err(|error| format!("无法显示 Harness 窗口: {error}"))?;
            window.set_focus().map_err(|error| format!("无法聚焦 Harness 窗口: {error}"))?;
            if let Some(control) = app.get_webview_window("main") {
                let _ = control.hide();
            }
            return Ok(());
        }

        let window = WebviewWindowBuilder::new(&app, "harness", WebviewUrl::External(runtime_url))
            .title("HarnessDock · DeepSeek Harness")
            .initialization_script(INIT_SCRIPT)
            .inner_size(1180.0, 780.0)
            .min_inner_size(720.0, 560.0)
            .resizable(true)
            .decorations(false)
            .build()
            .map_err(|error| format!("无法创建 Harness WebView: {error}"))?;
        window
            .show()
            .map_err(|error| format!("无法显示 Harness WebView: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("无法聚焦 Harness WebView: {error}"))?;
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

/// Reload only the Harness WebView document. This keeps the Runtime, Gateway,
/// session and plugin state alive, so it is the safe first-line recovery action
/// for a renderer that is stale or visually stuck.
#[tauri::command]
pub fn harness_reload_web(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("移动端不提供桌面 Harness WebView 刷新命令。".into());
    }

    #[cfg(not(mobile))]
    {
        let window = harness_window(&app)?;
        window
            .eval("window.location.reload()")
            .map_err(|error| format!("无法刷新 Harness Web 界面: {error}"))
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
        if state.web_restarting.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err("Harness Web 正在重启，请稍候再试。".into());
        }
        let _restarting = WebRestartGuard(&state.web_restarting);

        // Hide the stale WebView while its loopback Runtime is being replaced.
        // If startup fails, surface the control page from the recovery path.
        if let Some(window) = app.get_webview_window("harness") {
            window
                .hide()
                .map_err(|error| format!("无法暂时隐藏 Harness Web 界面: {error}"))?;
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

#[tauri::command]
pub fn shell_settings_show(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("移动端不提供桌面外壳设置插件。".into());
    }

    #[cfg(not(mobile))]
    {
        show_settings_window(&app)
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
            window.hide().map_err(|error| format!("无法隐藏外壳设置插件: {error}"))?;
        }
        Ok(())
    }
}
