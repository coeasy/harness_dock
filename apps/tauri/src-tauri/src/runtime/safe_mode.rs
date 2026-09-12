//! Explicit safe-mode plugin isolation.
//!
//! Safe mode is stronger than normal automatic quarantine: it runs with a
//! private DSH_HOME and applies a tiny, reviewed deny-list for optional
//! upstream Web UI rows that are known to be able to fail before the browser
//! surface becomes usable. Core Runtime, transport, session, renderer and
//! HarnessDock bridge rows are deliberately absent from this list.

/// Optional official Web rows disabled only for an explicit safe-mode boot.
///
/// `ui-sidebar-documentpreview` bundles PDF.js. On older WebView2 builds the
/// client bundle can fail while importing PDF.js when the global `Iterator`
/// constructor is unavailable. Normal startup keeps the feature enabled and
/// relies on HarnessDock's WebView compatibility layer; safe mode disables the
/// optional preview row as a deterministic recovery fallback.
pub const SAFE_MODE_OPTIONAL_OFFICIAL_IDS: &[&str] = &["ui-sidebar-documentpreview"];

pub fn isolated_plugin_ids() -> Vec<String> {
    SAFE_MODE_OPTIONAL_OFFICIAL_IDS
        .iter()
        .map(|value| (*value).to_string())
        .collect()
}

pub fn patch() -> String {
    SAFE_MODE_OPTIONAL_OFFICIAL_IDS
        .iter()
        .map(|id| format!("- id: {id}\n  disabled: true\n"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_mode_isolates_only_the_reviewed_optional_document_preview_row() {
        assert_eq!(
            SAFE_MODE_OPTIONAL_OFFICIAL_IDS,
            &["ui-sidebar-documentpreview"]
        );
        assert_eq!(
            patch(),
            "- id: ui-sidebar-documentpreview\n  disabled: true\n"
        );
    }

    #[test]
    fn safe_mode_never_disables_core_web_runtime_rows() {
        let patch = patch();
        for protected in [
            "modules",
            "connection",
            "cordis-client-runner",
            "ui-theme",
            "locale",
            "ui-layout",
            "ui-renderer",
            "ui-session",
            "resources",
            "ui-sidebar",
            "ui-sidebar-right",
            "embedded-client",
            "harnessdock-client-runtime-compat",
            "harness-shell",
        ] {
            assert!(
                !patch.contains(&format!("- id: {protected}\n")),
                "safe mode must preserve core row {protected}"
            );
        }
    }
}
