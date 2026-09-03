//! Tauri IPC adapter registry.
//!
//! Legacy command names remain as compatibility adapters for bundled local
//! pages, while `host_execute` is the typed Host Protocol v2 entry point. Native
//! menu/tray code never calls IPC; it submits HostCommand directly to the
//! Reconciler. Remote Harness Web never receives legacy business-command
//! permissions: its authority is derived here from the real WebView label,
//! current URL origin and current RuntimeLease.

use tauri::{AppHandle, Manager};

use crate::host_protocol::{
    CommandEnvelope, HostError, HostResponse, HostSnapshot, ResponseEnvelope, SubjectKind,
    HOST_PROTOCOL_VERSION,
};
use crate::surface_actor::SurfaceKind;

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
        _ if cfg!(mobile) => {
            if claimed != SubjectKind::Mobile {
                return Err(HostError::new(
                    "SUBJECT_MISMATCH",
                    ErrorScope::Protocol,
                    "Mobile WebView must use the mobile subject",
                    false,
                ));
            }
            Ok(SubjectKind::Mobile)
        }
        _ => Err(HostError::new(
            "UNTRUSTED_SURFACE",
            ErrorScope::Protocol,
            "This window is not a Host Protocol surface",
            false,
        )),
    }
}

fn snapshot_subject(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(SubjectKind, SurfaceKind, Option<String>, Option<u64>), HostError> {
    use crate::host_protocol::ErrorScope;
    match window.label() {
        "harness" => {
            let subject = trusted_subject(app, window, SubjectKind::HarnessWeb)?;
            let lease = crate::runtime::current_lease(&*app.state::<crate::AppState>()).ok_or_else(|| {
                HostError::new(
                    "RUNTIME_LEASE_REQUIRED",
                    ErrorScope::Runtime,
                    "Harness snapshot has no current RuntimeLease",
                    true,
                )
            })?;
            let origin = window.url().ok().map(|url| url.origin().ascii_serialization());
            Ok((subject, SurfaceKind::Harness, origin, Some(lease.generation.id)))
        }
        "settings" => Ok((SubjectKind::Diagnostics, SurfaceKind::Diagnostics, None, None)),
        "control" => Ok((SubjectKind::DesktopShell, SurfaceKind::Diagnostics, None, None)),
        _ if cfg!(mobile) => Ok((SubjectKind::Mobile, SurfaceKind::Gateway, None, None)),
        _ => Err(HostError::new(
            "UNTRUSTED_SURFACE",
            ErrorScope::Protocol,
            "This window cannot request a Host capability snapshot",
            false,
        )),
    }
}

#[tauri::command]
pub fn host_snapshot(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<HostSnapshot, HostError> {
    let (subject, surface, origin, runtime_generation) = snapshot_subject(&app, &window)?;
    let state = app.state::<crate::AppState>();
    let (runtime_phase, current_generation) = state
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
    let lease = crate::runtime::current_lease(&*state);
    let capabilities = crate::capability_broker::allowed_capabilities(
        subject,
        surface,
        origin.as_deref(),
        runtime_generation,
        lease.as_ref(),
    );
    Ok(HostSnapshot {
        protocol_version: HOST_PROTOCOL_VERSION,
        runtime_phase,
        runtime_generation: current_generation,
        harness_visible,
        gateway_enabled,
        capabilities,
    })
}

/// Public diagnostics status never exposes the private launch credential URL.
/// Internal startup/restart flows continue to consume RuntimeLease.launch_url.
#[tauri::command]
pub fn runtime_status(app: AppHandle) -> crate::runtime::RuntimeStatus {
    let mut status = crate::runtime::status_snapshot(&*app.state::<crate::AppState>());
    status.app_url = status.app_url.and_then(|value| {
        url::Url::parse(&value).ok().map(|mut parsed| {
            parsed.set_username("").ok();
            let _ = parsed.set_password(None);
            parsed.set_query(None);
            parsed.set_fragment(None);
            parsed.to_string()
        })
    });
    status
}

/// Diagnostics is an on-demand Surface. Closing it destroys the WebView instead
/// of leaving a permanent hidden renderer behind.
#[tauri::command]
pub fn shell_settings_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .close()
            .map_err(|error| format!("无法关闭插件诊断窗口: {error}"))?;
    }
    Ok(())
}

macro_rules! handler {
    () => {
        tauri::generate_handler![
            $crate::bridge::host_execute,
            $crate::bridge::host_snapshot,
            $crate::bridge::runtime_status,
            $crate::bridge::shell_settings_close,
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
            $crate::harness_window::splash_status,
            $crate::harness_window::startup_recovery_status,
            $crate::harness_window::app_quit,
            $crate::runtime::runtime_start,
            $crate::runtime::runtime_stop,
            $crate::runtime::runtime_clear_plugin_quarantine,
            $crate::update::update_check,
            $crate::update::update_install,
        ]
    };
}

pub(crate) use handler;
