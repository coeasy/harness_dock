use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::runtime_actor::RuntimePhase;

include!("host_protocol_generated.rs");

pub const HOST_PROTOCOL_MIN_COMPATIBLE_VERSION: u16 = 2;
pub const HOST_PROTOCOL_SCHEMA_HASH: &str = "host-protocol-v2";
pub const HOST_PROTOCOL_FEATURE_FLAGS: [&str; 4] = [
    "kernel-queue",
    "ordered-events",
    "snapshot-resync",
    "request-dedupe",
];

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
        if self.protocol_version < HOST_PROTOCOL_MIN_COMPATIBLE_VERSION
            || self.protocol_version > HOST_PROTOCOL_VERSION
        {
            return Err(HostError::new(
                "PROTOCOL_VERSION_UNSUPPORTED",
                ErrorScope::Protocol,
                format!(
                    "Host Protocol v{}-v{} is supported; received v{}",
                    HOST_PROTOCOL_MIN_COMPATIBLE_VERSION,
                    HOST_PROTOCOL_VERSION,
                    self.protocol_version
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostEventKind {
    CommandSucceeded,
    CommandFailed,
    SnapshotInvalidated,
    RuntimeHealthChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    pub protocol_version: u16,
    pub sequence: u64,
    pub revision: u64,
    pub operation_id: String,
    pub request_id: String,
    pub kind: HostEventKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub protocol_version: u16,
    pub min_compatible_version: u16,
    pub schema_hash: String,
    pub feature_flags: Vec<String>,
    pub revision: u64,
    pub event_sequence: u64,
    pub runtime_phase: RuntimePhase,
    pub runtime_generation: Option<u64>,
    pub runtime_dsh_version: Option<String>,
    pub runtime_image_identity: Option<String>,
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
        assert_eq!(
            serde_json::to_value(envelope.subject).unwrap(),
            "harness-web"
        );
    }

    #[test]
    fn protocol_command_capability_mapping_is_generated() {
        assert_eq!(
            HostCommand::RestartRuntime.capability(),
            Capability::RuntimeRestart
        );
        assert_eq!(
            HostCommand::InstallUpdate.capability(),
            Capability::UpdateInstall
        );
    }

    #[test]
    fn protocol_uses_runtime_actor_phase_including_cancellation() {
        let snapshot = HostSnapshot {
            protocol_version: HOST_PROTOCOL_VERSION,
            min_compatible_version: HOST_PROTOCOL_MIN_COMPATIBLE_VERSION,
            schema_hash: HOST_PROTOCOL_SCHEMA_HASH.into(),
            feature_flags: HOST_PROTOCOL_FEATURE_FLAGS
                .iter()
                .map(|value| (*value).into())
                .collect(),
            revision: 3,
            event_sequence: 5,
            runtime_phase: RuntimePhase::Cancelling,
            runtime_generation: Some(7),
            runtime_dsh_version: None,
            runtime_image_identity: None,
            harness_visible: false,
            gateway_enabled: false,
            capabilities: vec![Capability::RuntimeRestart],
        };
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["runtimePhase"], "cancelling");
        assert_eq!(json["runtimeGeneration"], 7);
        assert_eq!(json["eventSequence"], 5);
    }
}
