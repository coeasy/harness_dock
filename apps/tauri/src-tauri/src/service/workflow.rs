use tauri::AppHandle;

use crate::host_protocol::{HostCommand, SubjectKind};
pub(crate) use crate::host_protocol::HostCommand as HostIntent;

/// Menu/tray/shell code submits typed intent only. Procedure sequencing lives
/// in the Reconciler so renderers never own Runtime/Gateway lifecycle order.
pub(crate) async fn execute(app: AppHandle, command: HostCommand) -> Result<(), String> {
    crate::reconciler::execute(app, SubjectKind::NativeMenu, command)
        .await
        .map_err(|error| error.message)
}
