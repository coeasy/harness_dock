use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

use crate::{
    capability_broker::{self, AuthorizationRequest, Decision},
    host_protocol::{ErrorScope, HostCommand, HostError, SubjectKind},
    surface_actor::SurfaceKind,
};

fn bump_revision(app: &AppHandle) {
    app.state::<crate::AppState>()
        .revision
        .fetch_add(1, Ordering::AcqRel);
}

fn host_error(code: &str, scope: ErrorScope, message: impl Into<String>, retryable: bool) -> HostError {
    HostError::new(code, scope, message, retryable)
}

fn authorize_local(app: &AppHandle, subject: SubjectKind, command: &HostCommand) -> Result<(), HostError> {
    let state = app.state::<crate::AppState>();
    let lease = crate::runtime::live_lease(&*state);
    let request = AuthorizationRequest {
        subject,
        surface: match subject {
            SubjectKind::Diagnostics => SurfaceKind::Diagnostics,
            SubjectKind::Mobile => SurfaceKind::Gateway,
            _ => SurfaceKind::Harness,
        },
        origin: lease.as_ref().map(|lease| lease.origin.as_str()),
        runtime_generation: lease.as_ref().map(|lease| lease.generation.id),
        capability: capability_broker::capability_for(command),
    };
    match capability_broker::authorize(&request, lease.as_ref()) {
        Decision::Allow => Ok(()),
        Decision::Deny(reason) => Err(host_error(
            "CAPABILITY_DENIED",
            ErrorScope::Protocol,
            format!("Host capability denied: {reason}"),
            false,
        )),
    }
}

pub(crate) async fn execute(app: AppHandle, subject: SubjectKind, command: HostCommand) -> Result<(), HostError> {
    authorize_local(&app, subject, &command)?;
    bump_revision(&app);
    reconcile_command(app, command).await.map_err(|message| {
        host_error("RECONCILE_FAILED", ErrorScope::Host, message, true)
    })
}

async fn activate_primary(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = app;
        Err("移动端没有本地 Harness 主窗口。".into())
    }
    #[cfg(not(mobile))]
    {
        let lease = crate::runtime::live_lease(&*app.state::<crate::AppState>())
            .ok_or_else(|| "Runtime 尚未就绪，无法激活 Harness 主窗口。".to_string())?;
        crate::harness_window::harness_open(app, lease.launch_url).await
    }
}

async fn reconcile_command(app: AppHandle, command: HostCommand) -> Result<(), String> {
    match command {
        HostCommand::ActivatePrimary => activate_primary(app).await,
        HostCommand::RefreshHarness => crate::harness_window::harness_reload_web(app).await,
        HostCommand::RestartRuntime => crate::harness_window::harness_restart_web(app).await.map(|_| ()),
        HostCommand::StartSafeMode => crate::harness_window::harness_safe_mode_restart(app).await.map(|_| ()),
        HostCommand::ClearQuarantine => crate::harness_window::harness_clear_quarantine_restart(app).await.map(|_| ()),
        HostCommand::ShowGateway => crate::harness_window::control_show(app),
        HostCommand::ShowDiagnostics => crate::harness_window::shell_settings_show(app).await,
        HostCommand::InstallUpdate => crate::update::update_install(app).await.map(|_| ()),
        HostCommand::Quit => { crate::request_exit(&app); Ok(()) }
    }
}

pub(crate) async fn ensure_runtime_for_boot(app: AppHandle) -> Result<crate::runtime::RuntimeStatus, String> {
    bump_revision(&app);
    crate::runtime::start_for_boot(app).await
}
