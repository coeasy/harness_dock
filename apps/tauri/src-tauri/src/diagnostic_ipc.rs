//! Diagnostics IPC handlers.
//!
//! Keeps Tauri command transport thin while delegating collection and export
//! decisions to diagnostics services.

use tauri::AppHandle;

use crate::{diagnostic_command, diagnostic_export, diagnostic_platform::DiagnosticSnapshot};

#[tauri::command]
pub fn diagnostics_snapshot() -> diagnostic_command::DiagnosticsResponse {
    diagnostic_command::response(DiagnosticSnapshot::default())
}

#[tauri::command]
pub fn diagnostics_export() -> diagnostic_export::DiagnosticBundle {
    diagnostic_export::DiagnosticBundle::new(DiagnosticSnapshot::default())
}

pub fn _keep_app_handle(_: Option<AppHandle>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_command_returns_ok() {
        assert!(diagnostics_snapshot().ok);
    }
}
