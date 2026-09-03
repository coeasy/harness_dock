use tauri::{AppHandle, Manager};

use crate::{
    capability_broker::{self, AuthorizationRequest, Decision},
    host_protocol::{Capability, ErrorScope, HostCommand, HostError, SubjectKind},
    runtime_actor::RuntimeMode,
    surface_actor::SurfaceKind,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AppDesiredState { Running, Exiting }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RuntimeDesiredState { Stopped, Ready, Safe }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SurfaceDesiredState { Hidden, Visible }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GatewayDesiredState { Disabled, Enabled }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UpdateDesiredState { Idle, Install }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostDesiredState {
    pub app: AppDesiredState,
    pub runtime: RuntimeDesiredState,
    pub harness_surface: SurfaceDesiredState,
    pub gateway: GatewayDesiredState,
    pub update: UpdateDesiredState,
    pub revision: u64,
}

impl Default for HostDesiredState {
    fn default() -> Self {
        Self {
            app: AppDesiredState::Running,
            runtime: RuntimeDesiredState::Ready,
            harness_surface: SurfaceDesiredState::Visible,
            gateway: GatewayDesiredState::Disabled,
            update: UpdateDesiredState::Idle,
            revision: 0,
        }
    }
}

impl HostDesiredState {
    fn touch(&mut self) { self.revision = self.revision.saturating_add(1); }
}

fn host_error(code: &str, scope: ErrorScope, message: impl Into<String>, retryable: bool) -> HostError {
    HostError::new(code, scope, message, retryable)
}

fn authorize_local(app: &AppHandle, subject: SubjectKind, command: &HostCommand) -> Result<(), HostError> {
    let state = app.state::<crate::AppState>();
    let lease = crate::runtime::current_lease(&*state);
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
    {
        let state = app.state::<crate::AppState>();
        let mut desired = state.desired.lock().map_err(|_| {
            host_error("DESIRED_STATE_POISONED", ErrorScope::Host, "Host desired-state lock is poisoned", true)
        })?;
        match command {
            HostCommand::RefreshHarness => desired.harness_surface = SurfaceDesiredState::Visible,
            HostCommand::RestartRuntime => {
                desired.runtime = RuntimeDesiredState::Ready;
                desired.harness_surface = SurfaceDesiredState::Visible;
            }
            HostCommand::StartSafeMode => {
                desired.runtime = RuntimeDesiredState::Safe;
                desired.harness_surface = SurfaceDesiredState::Visible;
            }
            HostCommand::ClearQuarantine => {
                desired.runtime = RuntimeDesiredState::Ready;
                desired.harness_surface = SurfaceDesiredState::Visible;
            }
            HostCommand::ShowGateway => desired.gateway = GatewayDesiredState::Enabled,
            HostCommand::ShowDiagnostics => {}
            HostCommand::InstallUpdate => desired.update = UpdateDesiredState::Install,
            HostCommand::Quit => desired.app = AppDesiredState::Exiting,
        }
        desired.touch();
    }
    reconcile_command(app, command).await.map_err(|message| {
        host_error("RECONCILE_FAILED", ErrorScope::Host, message, true)
    })
}

async fn reconcile_command(app: AppHandle, command: HostCommand) -> Result<(), String> {
    match command {
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
    {
        let state = app.state::<crate::AppState>();
        let mut desired = state.desired.lock().map_err(|_| "Host desired-state lock is poisoned".to_string())?;
        desired.runtime = RuntimeDesiredState::Ready;
        desired.harness_surface = SurfaceDesiredState::Visible;
        desired.touch();
    }
    crate::runtime::start_for_boot(app).await
}

pub(crate) fn runtime_mode_for_desired(desired: RuntimeDesiredState) -> RuntimeMode {
    match desired {
        RuntimeDesiredState::Safe => RuntimeMode::Safe,
        RuntimeDesiredState::Stopped | RuntimeDesiredState::Ready => RuntimeMode::Normal,
    }
}

pub(crate) fn command_capability(command: &HostCommand) -> Capability {
    capability_broker::capability_for(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desired_state_revision_changes_with_intent() {
        let mut desired = HostDesiredState::default();
        desired.runtime = RuntimeDesiredState::Safe;
        desired.touch();
        assert_eq!(desired.revision, 1);
    }
    #[test]
    fn safe_desired_state_maps_to_safe_runtime_mode() {
        assert_eq!(runtime_mode_for_desired(RuntimeDesiredState::Safe), RuntimeMode::Safe);
    }
}
