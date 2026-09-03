//! Tauri IPC adapter registry.
//!
//! Legacy command names remain as compatibility adapters for bundled local
//! pages, while `host_execute` is the typed Host Protocol v2 entry point. Native
//! menu/tray code never calls IPC; it submits HostCommand directly to the
//! Reconciler.

use tauri::{AppHandle, Manager};

use crate::host_protocol::{
    Capability, CommandEnvelope, HostError, HostResponse, HostSnapshot, ResponseEnvelope,
    SubjectKind, HOST_PROTOCOL_VERSION,
};

#[tauri::command]
pub async fn host_execute(
    app: AppHandle,
    window: tauri::WebviewWindow,
    envelope: CommandEnvelope,
) -> ResponseEnvelope {
    let request_id = envelope.request_id.clone();
    let result = match envelope.validate() {
        Err(error) => Err(error),
        Ok(()) => match trusted_subject(&app, &window, envelope.subject) {
            Err(error) => Err(error),
            Ok(subject) => crate::reconciler::execute(app, subject, envelope.command)
                .await
                .map(|_| HostResponse::Ack),
        },
    };
    ResponseEnvelope {
        protocol_version: HOST_PROTOCOL_VERSION,
        request_id,
        result,
    }
}

fn trusted_subject(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    claimed: SubjectKind,
) -> Result<SubjectKind, HostError> {
    use crate::host_protocol::ErrorScope;
    let label = window.label();
    match label {
        "harness" => {
            if claimed != SubjectKind::HarnessWeb {
                return Err(HostError::new(
                    "SUBJECT_MISMATCH",
                    ErrorScope::Protocol,
                    "Harness WebView must use the harness-web subject",
                    false,
                ));
            }
            let lease = crate::runtime::current_lease(&*app.state::<crate::AppState>())
                .ok_or_else(|| {
                    HostError::new(
                        "RUNTIME_LEASE_REQUIRED",
                        ErrorScope::Runtime,
                        "Harness subject has no current RuntimeLease",
                        true,
                    )
                })?;
            let actual = window
                .url()
                .ok()
                .map(|url| url.origin().ascii_serialization());
            if actual.as_deref() != Some(lease.origin.as_str()) {
                return Err(HostError::new(
                    "ORIGIN_MISMATCH",
                    ErrorScope::Protocol,
                    "Harness WebView origin does not match the current RuntimeLease",
                    false,
                ));
            }
            Ok(SubjectKind::HarnessWeb)
        }
        "settings" => {
            if claimed != SubjectKind::Diagnostics {
                return Err(HostError::new(
                    "SUBJECT_MISMATCH",
                    ErrorScope::Protocol,
                    "Diagnostics window must use the diagnostics subject",
                    false,
                ));
            }
            Ok(SubjectKind::Diagnostics)
        }
        "control" => {
            if !matches!(claimed, SubjectKind::DesktopShell | SubjectKind::Diagnostics) {
                return Err(HostError::new(
                    "SUBJECT_MISMATCH",
                    ErrorScope::Protocol,
                    "On-demand local control surface cannot impersonate native/menu/tray subjects",
                    false,
                ));
            }
            Ok(claimed)
        }
        _ if cfg!(mobile) => Ok(SubjectKind::Mobile),
        _ => Err(HostError::new(
            "UNTRUSTED_SURFACE",
            ErrorScope::Protocol,
            "This window is not a Host Protocol surface",
            false,
        )),
    }
}

#[tauri::command]
pub fn host_snapshot(app: AppHandle) -> HostSnapshot {
    let state = app.state::<crate::AppState>();
    let (runtime_phase, runtime_generation) = state
        .runtime_actor
        .lock()
        .map(|actor| (actor.phase(), actor.generation_id()))
        .unwrap_or((crate::runtime_actor::RuntimePhase::Failed, None));
    let harness_visible = state
        .surface_actor
        .lock()
        .map(|actor| actor.primary_visible())
        .unwrap_or(false);
    let gateway_enabled = state
        .gateway
        .lock()
        .map(|actor| actor.phase() == crate::gateway_host::GatewayPhase::Ready)
        .unwrap_or(false);
    HostSnapshot {
        protocol_version: HOST_PROTOCOL_VERSION,
        runtime_phase,
        runtime_generation,
        harness_visible,
        gateway_enabled,
        capabilities: vec![
            Capability::WindowControl,
            Capability::WebReload,
            Capability::RuntimeRestart,
            Capability::RuntimeSafeMode,
            Capability::RuntimeClearQuarantine,
            Capability::GatewayManage,
            Capability::DiagnosticsRead,
            Capability::UpdateCheck,
            Capability::UpdateInstall,
            Capability::AppQuit,
        ],
    }
}

macro_rules! handler {
    () => {
        tauri::generate_handler![
            $crate::bridge::host_execute,
            $crate::bridge::host_snapshot,
            $crate::platform::platform_info,
            $crate::gateway::gateway_health,
            $crate::gateway::pair_gateway,
            $crate::gateway_host::gateway_host_status,
            $crate::gateway_host::gateway_host_start,
            $crate::gateway_host::gateway_host_create_pairing,
            $crate::gateway_host::gateway_host_revoke,
            $crate::gateway_host::gateway_host_revoke_all,
            $crate::gateway_host::gateway_host_stop,
            $crate::harness_window::harness_open,
            $crate::harness_window::harness_close,
            $crate::harness_window::harness_minimize,
            $crate::harness_window::harness_toggle_maximize,
            $crate::harness_window::harness_window_state,
            $crate::harness_shell::harness_shell_close,
            $crate::harness_window::control_show,
            $crate::harness_window::harness_reload_web,
            $crate::harness_window::harness_restart_web,
            $crate::harness_window::harness_safe_mode_restart,
            $crate::harness_window::harness_clear_quarantine_restart,
            $crate::harness_window::shell_settings_show,
            $crate::harness_window::shell_settings_close,
            $crate::harness_window::splash_status,
            $crate::harness_window::startup_recovery_status,
            $crate::harness_window::app_quit,
            $crate::runtime::runtime_status,
            $crate::runtime::runtime_start,
            $crate::runtime::runtime_stop,
            $crate::runtime::runtime_clear_plugin_quarantine,
            $crate::update::update_check,
            $crate::update::update_install,
        ]
    };
}

pub(crate) use handler;
