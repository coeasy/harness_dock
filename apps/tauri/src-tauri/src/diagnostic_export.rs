//! Diagnostic export foundation.
//!
//! Provides a stable export payload that can later be written as a bundle
//! containing runtime, lifecycle and log information.

use serde::Serialize;

use crate::diagnostic_platform::DiagnosticSnapshot;

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticBundle {
    pub version: String,
    pub snapshot: DiagnosticSnapshot,
}

impl DiagnosticBundle {
    pub fn new(snapshot: DiagnosticSnapshot) -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            snapshot,
        }
    }

    pub fn filename(&self) -> String {
        format!("harnessdock-diagnostic-{}.json", self.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_has_version() {
        let bundle = DiagnosticBundle::new(DiagnosticSnapshot::default());
        assert!(!bundle.version.is_empty());
    }
}
