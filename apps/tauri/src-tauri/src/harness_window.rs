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
            .inner_size(1180.0, 780.0)
            .min_inner_size(720.0, 560.0)
            .resizable(true)
            .build()
            .map_err(|error| format!("无法创建 Harness WebView: {error}"))?;
        let control_app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(control) = control_app.get_webview_window("main") {
                    let _ = control.show();
                    let _ = control.set_focus();
                }
            }
        });
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
            window.close().map_err(|error| format!("无法关闭 Harness 窗口: {error}"))?;
        }
        if let Some(control) = app.get_webview_window("main") {
            control.show().map_err(|error| format!("无法显示 HarnessDock 控制页: {error}"))?;
            control.set_focus().map_err(|error| format!("无法聚焦 HarnessDock 控制页: {error}"))?;
        }
        Ok(())
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
