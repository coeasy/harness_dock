//! Tauri IPC bridge boundary for HarnessDock.
//!
//! The bridge is the only Tauri command registration boundary for desktop
//! surfaces. Lifecycle mutations still flow through the Host Kernel, while
//! read-only adapters expose the snapshots needed by local control pages.

use tauri::{AppHandle, Manager, State, WebviewWindow};

macro_rules! handler {
    () => {
        tauri::generate_handler![
            $crate::bridge::host_execute,
            $crate::bridge::host_snapshot,
            $crate::bridge::public_runtime_status,
            $crate::bridge::diagnostics_close,
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
            $crate::harness_window::control_show,
            $crate::harness_window::harness_reload_web,
            $crate::harness_window::harness_restart_web,
            $crate::harness_window::harness_safe_mode_restart,
            $crate::harness_window::harness_clear_quarantine_restart,
            $crate::harness_shell::harness_shell_close,
            $crate::harness_window::shell_settings_show,
            $crate::harness_window::splash_status,
            $crate::harness_window::startup_recovery_status,
            $crate::runtime::runtime_status,
            $crate::runtime::runtime_start,
            $crate::runtime::runtime_stop,
            $crate::runtime::runtime_clear_plugin_quarantine,
            $crate::runtime::runtime_launch_settings_get,
            $crate::runtime::runtime_launch_settings_set,
            $crate::update::update_check,
            $crate::update::update_install,
            $crate::diagnostic_ipc::diagnostics_snapshot,
            $crate::diagnostic_ipc::diagnostics_export
        ]
    };
}

pub(crate) use handler;

fn trusted_subject(
    app: &AppHandle,
    window: &WebviewWindow<tauri::Wry>,
    requested: crate::host_protocol::SubjectKind,
) -> Result<crate::host_protocol::SubjectKind, String> {
    use crate::host_protocol::SubjectKind;

    let expected = match window.label() {
        "harness" => SubjectKind::HarnessWeb,
        "settings" => SubjectKind::Diagnostics,
        "control" => SubjectKind::DesktopShell,
        label => return Err(format!("Host Protocol 不允许 WebView {label} 作为调用方。")),
    };
    if requested != expected {
        return Err("Host Protocol 调用方身份与真实 WebView 不一致。".into());
    }
    if expected == SubjectKind::HarnessWeb {
        let lease = crate::harness_window::current_runtime_lease(app)?;
        let origin = window
            .url()
            .map_err(|error| format!("无法读取 Harness WebView URL: {error}"))?
            .origin()
            .ascii_serialization();
        if origin != lease.origin {
            return Err("Harness WebView origin 与当前 RuntimeLease 不一致。".into());
        }
    }
    Ok(expected)
}

#[tauri::command]
pub async fn host_execute(
    app: AppHandle,
    window: WebviewWindow<tauri::Wry>,
    mut envelope: crate::host_protocol::CommandEnvelope,
) -> crate::host_protocol::ResponseEnvelope {
    let request_id = envelope.request_id.clone();
    envelope.subject = match trusted_subject(&app, &window, envelope.subject) {
        Ok(subject) => subject,
        Err(error) => {
            return crate::host_kernel::rejected_response(
                request_id,
                "CALLER_IDENTITY_INVALID",
                error,
            )
        }
    };
    if let Err(error) = envelope.validate() {
        return crate::host_kernel::invalid_response(request_id, error);
    }
    crate::host_kernel::execute_envelope(&app, envelope).await
}

#[tauri::command]
pub fn host_snapshot(
    app: AppHandle,
    window: WebviewWindow<tauri::Wry>,
) -> Result<crate::host_protocol::HostSnapshot, String> {
    let subject = trusted_subject(
        &app,
        &window,
        match window.label() {
            "harness" => crate::host_protocol::SubjectKind::HarnessWeb,
            "settings" => crate::host_protocol::SubjectKind::Diagnostics,
            "control" => crate::host_protocol::SubjectKind::DesktopShell,
            _ => return Err("Host snapshot 不允许此 WebView 读取。".into()),
        },
    )?;
    let state = app.state::<crate::AppState>();
    let snapshot = crate::service::snapshot::ReadOnlySnapshot::collect(&state);
    let public = crate::host_kernel::public_state(&app);
    let surface = match subject {
        crate::host_protocol::SubjectKind::Diagnostics => {
            crate::surface_actor::SurfaceKind::Diagnostics
        }
        crate::host_protocol::SubjectKind::HarnessWeb => crate::surface_actor::SurfaceKind::Harness,
        _ => crate::surface_actor::SurfaceKind::Recovery,
    };
    let lease = snapshot.runtime_lease.as_ref();
    Ok(crate::host_protocol::HostSnapshot {
        protocol_version: crate::host_protocol::HOST_PROTOCOL_VERSION,
        min_compatible_version: crate::host_protocol::HOST_PROTOCOL_MIN_COMPATIBLE_VERSION,
        schema_hash: crate::host_protocol::HOST_PROTOCOL_SCHEMA_HASH.into(),
        feature_flags: crate::host_protocol::HOST_PROTOCOL_FEATURE_FLAGS
            .iter()
            .map(|flag| (*flag).into())
            .collect(),
        revision: public.revision,
        event_sequence: public.event_sequence,
        runtime_phase: snapshot.runtime_phase,
        runtime_generation: snapshot.runtime_generation,
        runtime_dsh_version: lease.map(|value| value.dsh_version.clone()),
        runtime_image_identity: lease.map(|value| value.generation.image_identity.clone()),
        harness_visible: snapshot.harness_visible,
        gateway_enabled: snapshot.gateway_enabled,
        capabilities: crate::capability_broker::allowed_capabilities(
            subject,
            surface,
            lease.map(|value| value.origin.as_str()),
            snapshot.runtime_generation,
            lease,
        ),
    })
}

#[tauri::command]
pub fn public_runtime_status(state: State<'_, crate::AppState>) -> crate::runtime::RuntimeStatus {
    let mut status = crate::runtime::status_snapshot(&*state);
    let failures = state
        .client_plugin_failures
        .lock()
        .map(|values| values.clone())
        .unwrap_or_default();
    for plugin in failures {
        append_client_plugin_failure(&mut status, plugin);
    }
    status
}

pub(crate) fn append_client_plugin_failure(
    status: &mut crate::runtime::RuntimeStatus,
    plugin: String,
) {
    if !status.suspected_plugins.contains(&plugin) {
        status.suspected_plugins.push(plugin);
    }
}

#[tauri::command]
pub fn diagnostics_close(window: WebviewWindow<tauri::Wry>) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("只有诊断 WebView 可以关闭诊断窗口。".into());
    }
    window
        .close()
        .map_err(|error| format!("无法关闭诊断窗口: {error}"))
}
