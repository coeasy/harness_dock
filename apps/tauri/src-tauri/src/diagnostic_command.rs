//! Diagnostics command adapter foundation.
//!
//! Keeps command transport independent from diagnostics collection logic.

use serde::Serialize;

use crate::diagnostic_platform::DiagnosticSnapshot;

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsResponse {
    pub ok: bool,
    pub snapshot: DiagnosticSnapshot,
}

pub fn response(snapshot: DiagnosticSnapshot) -> DiagnosticsResponse {
    DiagnosticsResponse { ok: true, snapshot }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_wraps_snapshot() {
        let result = response(DiagnosticSnapshot::default());
        assert!(result.ok);
    }
}
