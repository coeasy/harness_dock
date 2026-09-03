use tauri::AppHandle;

use crate::host_protocol::{HostCommand, SubjectKind};
pub(crate) use crate::host_protocol::HostCommand as HostIntent;

/// Native menu/tray code enters the same HostKernelTask queue as WebView
/// requests. This guarantees one ordering/dedupe/event path for business
/// commands; native surfaces do not call Runtime/Gateway procedures directly.
pub(crate) async fn execute(app: AppHandle, command: HostCommand) -> Result<(), String> {
    crate::host_kernel::execute_native(app, SubjectKind::NativeMenu, command)
        .await
        .map_err(|error| error.message)
}
