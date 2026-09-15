//! Extended diagnostics payload for startup/runtime/shutdown optimization.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct RuntimeLifecycleDiagnostics {
    pub startup_path: Option<String>,
    pub recovery_attempts: u32,
    pub last_recovery_action: Option<String>,
    pub shutdown_action: Option<String>,
}

impl RuntimeLifecycleDiagnostics {
    pub fn fast_start() -> Self {
        Self {
            startup_path: Some("fast".into()),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_start_is_reportable() {
        assert_eq!(
            RuntimeLifecycleDiagnostics::fast_start().startup_path,
            Some("fast".into())
        );
    }
}
