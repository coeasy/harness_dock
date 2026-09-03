//! Application command execution behind native adapters.
//!
//! Menu/Tray express typed Host Protocol v2 commands and must not encode
//! Runtime/Gateway/WebView stop/start ordering themselves. Later rounds move
//! the implementation behind Actor/Reconciler handles while preserving this
//! protocol boundary.

use crate::host_protocol::HostCommand;
use tauri::AppHandle;

pub(crate) use crate::host_protocol::HostCommand as HostIntent;

pub(crate) async fn execute(app: AppHandle, command: HostCommand) -> Result<(), String> {
    match command {
        HostCommand::RefreshHarness => crate::harness_window::harness_reload_web(app).await,
        HostCommand::RestartRuntime => crate::harness_window::harness_restart_web(app)
            .await
            .map(|_| ()),
        HostCommand::StartSafeMode => crate::harness_window::harness_safe_mode_restart(app)
            .await
            .map(|_| ()),
        HostCommand::ClearQuarantine => {
            crate::harness_window::harness_clear_quarantine_restart(app)
                .await
                .map(|_| ())
        }
        HostCommand::ShowGateway => crate::harness_window::control_show(app),
        HostCommand::ShowDiagnostics => crate::harness_window::shell_settings_show(app)
            .await
            .map(|_| ()),
        HostCommand::InstallUpdate => crate::update::update_install(app).await.map(|_| ()),
        HostCommand::Quit => {
            crate::request_exit(&app);
            Ok(())
        }
    }
}
