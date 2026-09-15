//! Unified lifecycle diagnostic report.

use serde::Serialize;

use crate::diagnostic_runtime_v2::RuntimeLifecycleDiagnostics;

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiagnosticReportV2 {
    pub app_version: String,
    pub lifecycle: RuntimeLifecycleDiagnostics,
}

impl DiagnosticReportV2 {
    pub fn with_lifecycle(
        version: impl Into<String>,
        lifecycle: RuntimeLifecycleDiagnostics,
    ) -> Self {
        Self {
            app_version: version.into(),
            lifecycle,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_contains_lifecycle_data() {
        let report =
            DiagnosticReportV2::with_lifecycle("test", RuntimeLifecycleDiagnostics::fast_start());
        assert_eq!(report.app_version, "test");
    }
}
