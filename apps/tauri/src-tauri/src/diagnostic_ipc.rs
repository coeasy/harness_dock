//! Diagnostics IPC handlers.
//!
//! Keeps Tauri command transport thin while delegating collection and export
//! decisions to diagnostics services.

use tauri::{AppHandle, Manager};

use crate::{diagnostic_command, diagnostic_export, diagnostic_platform::DiagnosticSnapshot};

fn collect_snapshot(app: &AppHandle) -> DiagnosticSnapshot {
    let state = app.state::<crate::AppState>();

    let runtime = state
        .runtime_supervisor
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let runtime_update = state
        .runtime_update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let plugins = state
        .plugin_manager
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let startup = state
        .startup_orchestrator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let shutdown = state
        .shutdown_manager
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    crate::diagnostic_service::snapshot(
        &runtime,
        &runtime_update,
        &plugins,
        &startup,
        &shutdown,
    )
}

#[tauri::command]
pub fn diagnostics_snapshot(app: AppHandle) -> diagnostic_command::DiagnosticsResponse {
    diagnostic_command::response(collect_snapshot(&app))
}

#[tauri::command]
pub fn diagnostics_export(app: AppHandle) -> diagnostic_export::DiagnosticBundle {
    diagnostic_export::DiagnosticBundle::new(collect_snapshot(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_export_path_exists() {
        let snapshot = DiagnosticSnapshot::default();
        assert!(diagnostic_export::DiagnosticBundle::new(snapshot)
            .filename()
            .contains("harnessdock-diagnostic"));
    }
}
