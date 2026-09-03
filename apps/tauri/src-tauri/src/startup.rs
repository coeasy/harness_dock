//! Native desktop startup coordinator.
//!
//! The control page is deliberately a recovery surface. Starting the local
//! Runtime from that hidden page made the first visible window depend on a
//! renderer, its IPC bridge, and a page-load race. Keep the critical startup
//! path in the native host so a failed WebView can never make the application
//! disappear without an exit route.

use crate::{
    harness_window, runtime,
    startup_trace::{self, StartupPhase},
};
use tauri::AppHandle;

pub(crate) fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        harness_window::show_splash(&app, "正在初始化客户端…");
        harness_window::show_splash(&app, "正在启动 Harness Runtime…");
        startup_trace::mark(StartupPhase::RuntimeStart);

        let status = match runtime::start_for_boot(app.clone()).await {
            Ok(status) => status,
            Err(error) => {
                startup_trace::mark(StartupPhase::Recovery);
                harness_window::show_startup_recovery(&app, &error);
                return;
            }
        };
        startup_trace::mark(StartupPhase::RuntimeReady);

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
        }
    });
}
