//! Application-level host intents used by native adapters.
//!
//! This is deliberately small: Menu/Tray should express *intent* and must not
//! encode Runtime/Gateway/WebView stop/start ordering themselves. Later rounds
//! replace the implementation calls below with Actor/Reconciler messages while
//! preserving this boundary.

use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostIntent {
    RefreshHarness,
    RestartRuntime,
    StartSafeMode,
    ClearQuarantine,
    ShowGateway,
    ShowDiagnostics,
    InstallUpdate,
    Quit,
}

pub(crate) async fn execute(app: AppHandle, intent: HostIntent) -> Result<(), String> {
    match intent {
        HostIntent::RefreshHarness => crate::harness_window::harness_reload_web(app).await,
        HostIntent::RestartRuntime => crate::harness_window::harness_restart_web(app)
            .await
            .map(|_| ()),
        HostIntent::StartSafeMode => crate::harness_window::harness_safe_mode_restart(app)
            .await
            .map(|_| ()),
        HostIntent::ClearQuarantine => {
            crate::harness_window::harness_clear_quarantine_restart(app)
                .await
                .map(|_| ())
        }
        HostIntent::ShowGateway => crate::harness_window::control_show(app),
        HostIntent::ShowDiagnostics => crate::harness_window::shell_settings_show(app)
            .await
            .map(|_| ()),
        HostIntent::InstallUpdate => crate::update::update_install(app).await.map(|_| ()),
        HostIntent::Quit => {
            crate::request_exit(&app);
            Ok(())
        }
    }
}
