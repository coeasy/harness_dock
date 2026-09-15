//! Explicit Rescue Web plugin isolation.
//!
//! Rescue mode is deliberately different from automatic quarantine. Automatic
//! recovery persists only plugins attributed to a concrete startup failure.
//! Rescue mode is an operator-requested, generation-local safety boundary: it
//! starts the shipped `web` profile while disabling every external/user plugin
//! row visible in the effective config tree. Official DeepSeek Web rows and the
//! three HarnessDock integration rows remain enabled so Harness Web stays usable.

use super::*;

const HARNESSDOCK_INTEGRATION_IDS: [&str; 3] = [
    "embedded-client",
    "harnessdock-client-runtime-compat",
    "harness-shell",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RescuePlan {
    pub isolated_rows: Vec<ConfigDumpRow>,
    pub suspected_plugins: Vec<String>,
}

impl RescuePlan {
    pub fn isolated_plugin_ids(&self) -> Vec<String> {
        self.isolated_rows
            .iter()
            .map(|row| row.id.clone())
            .collect()
    }

    pub fn patch(&self) -> Result<String, String> {
        recovery_patch(&self.isolated_rows)
    }
}

fn is_harnessdock_integration(row: &ConfigDumpRow) -> bool {
    HARNESSDOCK_INTEGRATION_IDS.contains(&row.id.as_str())
}

/// Rescue mode treats provenance as authoritative. A row coming from the
/// shipped DeepSeek package graph is official even if its declared name is
/// unusual. Conversely, a row written by a user/profile patch is external even
/// if it declares an `@deepseek-ai/*`-looking package name. This closes the gap
/// where a damaged or misleading user patch could otherwise escape isolation.
fn rescue_candidates(rows: &[ConfigDumpRow]) -> Vec<ConfigDumpRow> {
    rows.iter()
        .filter(|row| {
            !is_harnessdock_integration(row)
                && !row.source.is_empty()
                && !is_official_source(&row.source)
        })
        .cloned()
        .collect()
}

fn rescue_suspects(rows: &[ConfigDumpRow], diagnostic: &str) -> Vec<String> {
    let fingerprint = crate::diagnostic::parse_diagnostic(diagnostic);
    let structured = fingerprint != crate::diagnostic::DiagnosticFingerprint::None;
    rows.iter()
        .filter(|row| {
            if structured {
                crate::diagnostic::fingerprint_matches(&fingerprint, &row_tokens(row))
            } else {
                diagnostic_matches(row, diagnostic)
            }
        })
        .map(|row| row.id.clone())
        .collect()
}

/// Build an ephemeral Rescue Web plan from the effective `web` config.
///
/// Normal automatic quarantine intentionally remains more conservative and
/// still uses `recovery_candidates` / `is_official_row`. Rescue Web instead
/// isolates every non-official *source* while preserving the official web graph
/// and HarnessDock integration rows.
pub fn plan(rows: &[ConfigDumpRow], diagnostic: Option<&str>) -> RescuePlan {
    let isolated_rows = rescue_candidates(rows);
    let suspected_plugins = diagnostic
        .filter(|value| !value.trim().is_empty())
        .map(|diagnostic| rescue_suspects(&isolated_rows, diagnostic))
        .unwrap_or_default();
    RescuePlan {
        isolated_rows,
        suspected_plugins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, name: &str, source: &str) -> ConfigDumpRow {
        ConfigDumpRow {
            id: id.into(),
            name: Some(name.into()),
            source: source.into(),
        }
    }

    #[test]
    fn rescue_isolates_every_external_row_and_preserves_official_web() {
        let rows = vec![
            row(
                "modules",
                "@deepseek-ai/dsh-client-modules",
                "@deepseek-ai/dsh-web-app",
            ),
            row(
                "ui-sidebar-documentpreview",
                "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
                "@deepseek-ai/dsh-web-app",
            ),
            row(
                "market-plugin",
                "@vendor/market-plugin",
                "/home/me/.dsh/cordis.patch.yml",
            ),
            row(
                "local-plugin",
                "file:///home/me/plugin.js",
                "/home/me/.dsh/profiles/web/cordis.patch.yml",
            ),
            row(
                "embedded-client",
                "file:///app/plugin-embedded-client/index.js",
                "/tmp/embedded.patch.yml",
            ),
        ];
        let rescue = plan(&rows, None);
        assert_eq!(
            rescue.isolated_plugin_ids(),
            vec!["market-plugin", "local-plugin"]
        );
        let patch = rescue.patch().expect("rescue patch");
        assert!(patch.contains("market-plugin"));
        assert!(patch.contains("local-plugin"));
        assert!(!patch.contains("modules"));
        assert!(!patch.contains("ui-sidebar-documentpreview"));
        assert!(!patch.contains("embedded-client"));
    }

    #[test]
    fn rescue_uses_source_provenance_not_a_spoofable_declared_name() {
        let rows = vec![
            row(
                "spoofed-user-plugin",
                "@deepseek-ai/dsh-client-ui-chat",
                "/home/me/.dsh/cordis.patch.yml",
            ),
            row(
                "official-unusual-name",
                "@vendor/transitive-helper",
                "@deepseek-ai/dsh-web-app",
            ),
        ];
        let rescue = plan(&rows, None);
        assert_eq!(rescue.isolated_plugin_ids(), vec!["spoofed-user-plugin"]);
    }

    #[test]
    fn rescue_highlights_only_external_plugins_matching_the_failure() {
        let rows = vec![
            row(
                "bad-market-plugin",
                "@vendor/bad-market-plugin",
                "/home/me/.dsh/cordis.patch.yml",
            ),
            row(
                "other-plugin",
                "@vendor/other-plugin",
                "/home/me/.dsh/cordis.patch.yml",
            ),
        ];
        let rescue = plan(
            &rows,
            Some("failed to import loader entry @vendor/bad-market-plugin"),
        );
        assert_eq!(rescue.isolated_plugin_ids().len(), 2);
        assert_eq!(rescue.suspected_plugins, vec!["bad-market-plugin"]);
    }

    #[test]
    fn explicit_rescue_without_a_failure_does_not_invent_suspects() {
        let rows = vec![row(
            "external",
            "@vendor/external",
            "/home/me/.dsh/cordis.patch.yml",
        )];
        let rescue = plan(&rows, None);
        assert_eq!(rescue.isolated_plugin_ids(), vec!["external"]);
        assert!(rescue.suspected_plugins.is_empty());
    }
}
