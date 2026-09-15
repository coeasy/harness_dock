//! Tauri IPC bridge boundary for HarnessDock.
//!
//! v1 rebuild keeps transport ownership in one place and delegates lifecycle
//! diagnostics to the dedicated diagnostics IPC module. Runtime/window/update
//! commands are added back through the same boundary in follow-up migrations.

#[macro_export]
macro_rules! handler {
    () => {
        tauri::generate_handler![
            $crate::diagnostic_ipc::diagnostics_snapshot,
            $crate::diagnostic_ipc::diagnostics_export
        ]
    };
}
