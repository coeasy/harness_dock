use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::runtime_actor::RuntimePhase;

pub const HOST_PROTOCOL_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubjectKind {
    DesktopShell,
    HarnessWeb,
    NativeMenu,
    Tray,
    Diagnostics,
    Mobile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    WindowControl,
    WebReload,
    RuntimeRestart,
    RuntimeSafeMode,
    RuntimeClearQuarantine,
    GatewayManage,
    DiagnosticsRead,
    UpdateCheck,
    UpdateInstall,
    AppQuit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostCommand {
    RefreshHarness,
    RestartRuntime,
    StartSafeMode,
    ClearQuarantine,
    ShowGateway,
    ShowDiagnostics,
    InstallUpdate,
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    pub subject: SubjectKind,
    pub command: HostCommand,
}

impl CommandEnvelope {
    pub fn validate(&self) -> Result<(), HostError> {
        if self.protocol_version != HOST_PROTOCOL_VERSION {
            return Err(HostError::new(
                "PROTOCOL_VERSION_UNSUPPORTED",
                ErrorScope::Protocol,
                format!(
                    "Host Protocol v{} is required; received v{}",
                    HOST_PROTOCOL_VERSION, self.protocol_version
                ),
                false,
            ));
        }
        if self.request_id.trim().is_empty() {
            return Err(HostError::new(
                "REQUEST_ID_REQUIRED",
                ErrorScope::Protocol,
                "requestId must not be empty",
                false,
            ));
        }
        if self.request_id.len() > 128 {
            return Err(HostError::new(
                "REQUEST_ID_TOO_LONG",
                ErrorScope::Protocol,
                "requestId must be at most 128 bytes",
                false,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorScope {
    Protocol,
    Runtime,
    Surface,
    Gateway,
    Update,
    Host,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: String,
    pub scope: ErrorScope,
    pub message: String,
    pub retryable: bool,
    pub recovery_action: Option<String>,
    pub correlation_id: Option<String>,
}

impl HostError {
    pub fn new(
        code: impl Into<String>,
        scope: ErrorScope,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            scope,
            message: message.into(),
            retryable,
            recovery_action: None,
            correlation_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum HostResponse {
    Ack,
    Data(Value),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    pub result: Result<HostResponse, HostError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub protocol_version: u16,
    pub runtime_phase: RuntimePhase,
    pub runtime_generation: Option<u64>,
    pub harness_visible: bool,
    pub gateway_enabled: bool,
    pub capabilities: Vec<Capability>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_protocol_version() {
        let envelope = CommandEnvelope {
            protocol_version: 1,
            request_id: "req-1".into(),
            subject: SubjectKind::NativeMenu,
            command: HostCommand::RefreshHarness,
        };
        let error = envelope.validate().unwrap_err();
        assert_eq!(error.code, "PROTOCOL_VERSION_UNSUPPORTED");
        assert_eq!(error.scope, ErrorScope::Protocol);
    }

    #[test]
    fn protocol_subject_has_explicit_untrusted_harness_web_identity() {
        let envelope = CommandEnvelope {
            protocol_version: HOST_PROTOCOL_VERSION,
            request_id: "req-2".into(),
            subject: SubjectKind::HarnessWeb,
            command: HostCommand::RestartRuntime,
        };
        assert!(envelope.validate().is_ok());
        assert_eq!(serde_json::to_value(envelope.subject).unwrap(), "harness-web");
    }

    #[test]
    fn protocol_uses_runtime_actor_phase_including_cancellation() {
        let snapshot = HostSnapshot {
            protocol_version: HOST_PROTOCOL_VERSION,
            runtime_phase: RuntimePhase::Cancelling,
            runtime_generation: Some(7),
            harness_visible: false,
            gateway_enabled: false,
            capabilities: vec![Capability::RuntimeRestart],
        };
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["runtimePhase"], "cancelling");
        assert_eq!(json["runtimeGeneration"], 7);
    }
}
