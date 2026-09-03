//! Native desktop startup coordinator.
//!
//! Normal launch has no hidden renderer dependency: verify sealed Runtime ->
//! spawn/probe actor generation -> request Harness surface. Recovery/Gateway
//! control surfaces are created only when explicitly needed.

use crate::{
    harness_window, reconciler,
    startup_trace::{self, StartupPhase},
};
use tauri::AppHandle;

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
        }
    });
}
