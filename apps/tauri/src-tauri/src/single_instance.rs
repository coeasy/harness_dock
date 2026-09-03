use tauri::AppHandle;

/// Adapter used by Tauri's official single-instance plugin.
///
/// A secondary process never manipulates windows, Runtime, Gateway, or Update
/// resources directly. It emits one typed Host command into the same bounded
/// Host Kernel queue used by every other native control surface.
pub(crate) fn handle_secondary_launch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::host_kernel::execute_native(
            app.clone(),
            crate::host_protocol::SubjectKind::DesktopShell,
            crate::host_protocol::HostCommand::ActivatePrimary,
        )
        .await
        {
            crate::desktop::report_shell_error(&app, &error.message);
        }
    });
}
