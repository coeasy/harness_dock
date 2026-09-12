//! Explicit Rescue Web plugin isolation.
//!
//! Rescue mode is deliberately different from automatic quarantine. Automatic
//! recovery persists only plugins attributed to a concrete startup failure.
//! Rescue mode is an operator-requested, generation-local safety boundary: it
//! starts the shipped `web` profile while disabling every external/user plugin
//! row visible in the effective config tree. Official DeepSeek Web rows and the
//! three HarnessDock integration rows remain enabled so Harness Web stays usable.

use super::*;

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

/// Build an ephemeral Rescue Web plan from the effective `web` config.
///
/// `recovery_candidates` is the canonical external-plugin classifier: it
/// excludes all `@deepseek-ai/*` rows and HarnessDock's embedded/compat/shell
/// rows. Reusing it here keeps normal automatic recovery and explicit rescue on
/// one definition of "third party" without weakening automatic quarantine.
pub fn plan(rows: &[ConfigDumpRow], diagnostic: Option<&str>) -> RescuePlan {
    let isolated_rows = recovery_candidates(rows);
    let suspected_plugins = diagnostic
        .filter(|value| !value.trim().is_empty())
        .map(|diagnostic| recovery_plan(rows, diagnostic).1)
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
