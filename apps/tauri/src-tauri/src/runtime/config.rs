//! Config-dump parsing and plugin-failure recovery planning.
//!
//! Pure functions over the config-dump text; the recovery boot loop that
//! consumes these results lives in `spawn` / `start`.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub fn embedded_patch(plugin: &Path, compatibility: &Path, shell: &Path) -> Result<String, String> {
    let plugin_url = Url::from_file_path(platform::node_cli_path(plugin))
        .map_err(|_| "无法把 embedded client 插件路径转换为 file URL。".to_string())?;
    let compatibility_url = Url::from_file_path(platform::node_cli_path(compatibility))
        .map_err(|_| "无法把客户端兼容层路径转换为 file URL。".to_string())?;
    let shell_url = Url::from_file_path(platform::node_cli_path(shell))
        .map_err(|_| "无法把 Harness Shell 插件路径转换为 file URL。".to_string())?;
    Ok(format!(
        "- insert:\n    - id: embedded-client\n      name: '{}'\n    - id: harnessdock-client-runtime-compat\n      name: '{}'\n    - id: harness-shell\n      name: '{}'\n",
        plugin_url.as_str().replace('\'', "''"),
        compatibility_url.as_str().replace('\'', "''"),
        shell_url.as_str().replace('\'', "''"),
    ))
}

pub fn decode_yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        return serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len().saturating_sub(1)].to_string());
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return value[1..value.len() - 1].replace("''", "'");
    }
    value.to_string()
}

pub fn parse_config_dump_rows(dump: &str) -> Vec<ConfigDumpRow> {
    let mut rows = Vec::new();
    let mut source = String::new();
    let mut current: Option<ConfigDumpRow> = None;
    for line in dump.lines() {
        if let Some(label) = line.strip_prefix("# == ") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            source = label
                .split(", patched by ")
                .next()
                .unwrap_or(label)
                .trim()
                .to_string();
            continue;
        }
        if let Some(raw_id) = line.strip_prefix("- id:") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            current = Some(ConfigDumpRow {
                id: decode_yaml_scalar(raw_id),
                name: None,
                source: source.clone(),
            });
            continue;
        }
        if let Some(row) = current.as_mut() {
            if let Some(raw_name) = line.strip_prefix("  name:") {
                row.name = Some(decode_yaml_scalar(raw_name));
            }
        }
    }
    if let Some(row) = current {
        rows.push(row);
    }
    rows
}

pub fn is_official_source(source: &str) -> bool {
    let normalized = source.replace('\\', "/");
    source.starts_with("@deepseek-ai/") || normalized.contains("/node_modules/@deepseek-ai/")
}

pub fn is_official_row(row: &ConfigDumpRow) -> bool {
    is_official_source(&row.source)
        || row.name.as_deref().is_some_and(|name| {
            name.starts_with("@deepseek-ai/")
                || name
                    .replace('\\', "/")
                    .contains("/node_modules/@deepseek-ai/")
        })
}

pub fn recovery_candidates(rows: &[ConfigDumpRow]) -> Vec<ConfigDumpRow> {
    rows.iter()
        .filter(|row| {
            !matches!(
                row.id.as_str(),
                "embedded-client" | "harnessdock-client-runtime-compat" | "harness-shell"
            ) && !row.source.is_empty()
                && !is_official_row(row)
        })
        .cloned()
        .collect()
}

pub fn basename(value: &str) -> &str {
    value.rsplit(['/', '\\']).next().unwrap_or(value)
}

pub fn diagnostic_matches(row: &ConfigDumpRow, diagnostic: &str) -> bool {
    let haystack = diagnostic.to_ascii_lowercase();
    let mut tokens = vec![row.id.as_str(), row.source.as_str(), basename(&row.source)];
    if let Some(name) = row.name.as_deref() {
        tokens.push(name);
        tokens.push(basename(name));
    }
    tokens
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value.len() >= 3)
        .any(|value| haystack.contains(&value))
}

pub fn row_tokens(row: &ConfigDumpRow) -> Vec<String> {
    let mut tokens = vec![
        row.id.clone(),
        row.source.clone(),
        basename(&row.source).to_string(),
    ];
    if let Some(name) = row.name.as_deref() {
        tokens.push(name.to_string());
        tokens.push(basename(name).to_string());
    }
    tokens
}

pub fn recovery_plan(
    rows: &[ConfigDumpRow],
    diagnostic: &str,
) -> (Vec<ConfigDumpRow>, Vec<String>, String) {
    let candidates = recovery_candidates(rows);
    // Prefer the structured fingerprint: `parse_diagnostic` extracts precise
    // fields (module name, file, path, port) once, and attribution matches
    // candidates against those fields. The legacy full-buffer substring scan
    // is only a fallback for diagnostics that carry no recognizable structure.
    let fingerprint = crate::diagnostic::parse_diagnostic(diagnostic);
    let structured = fingerprint != crate::diagnostic::DiagnosticFingerprint::None;
    let suspected = candidates
        .iter()
        .filter(|row| {
            if structured {
                crate::diagnostic::fingerprint_matches(&fingerprint, &row_tokens(row))
            } else {
                diagnostic_matches(row, diagnostic)
            }
        })
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
    let reason = if suspected.is_empty() {
        "ambiguous"
    } else {
        "diagnostic-match"
    };
    (candidates, suspected, reason.to_string())
}

pub fn recovery_patch_ids(ids: &[String]) -> Result<String, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut output = String::new();
    for value in ids {
        if !seen.insert(value.clone()) {
            continue;
        }
        let id = serde_json::to_string(value).map_err(|error| error.to_string())?;
        output.push_str(&format!("- id: {id}\n  disabled: true\n"));
    }
    Ok(output)
}

pub fn recovery_patch(rows: &[ConfigDumpRow]) -> Result<String, String> {
    recovery_patch_ids(&rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>())
}

pub fn user_patch_rows(profile: &str, explicit_home: Option<&Path>) -> Vec<ConfigDumpRow> {
    let home = explicit_home.map(Path::to_path_buf).or_else(dsh_home_path);
    let Some(home) = home else {
        return Vec::new();
    };
    let paths = [
        home.join("profiles").join(profile).join("cordis.patch.yml"),
        home.join("cordis.patch.yml"),
    ];
    let mut rows = Vec::new();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let source = path.to_string_lossy().into_owned();
        let mut current: Option<ConfigDumpRow> = None;
        for line in raw.lines().map(str::trim_start) {
            if let Some(raw_id) = line.strip_prefix("- id:") {
                if let Some(row) = current.take() {
                    rows.push(row);
                }
                current = Some(ConfigDumpRow {
                    id: decode_yaml_scalar(raw_id),
                    name: None,
                    source: source.clone(),
                });
            } else if let Some(row) = current.as_mut() {
                if let Some(raw_name) = line.strip_prefix("name:") {
                    row.name = Some(decode_yaml_scalar(raw_name));
                }
            }
        }
        if let Some(row) = current {
            rows.push(row);
        }
    }
    rows
}

pub fn recovery_rows(
    image: &RuntimeImage,
    launch: &RuntimeLaunchSpec,
    embedded_patch_file: &Path,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<Vec<ConfigDumpRow>, String> {
    match dump_config(
        image,
        launch,
        embedded_patch_file,
        false,
        token,
        starting_processes,
        quitting,
    ) {
        Ok(config) => Ok(parse_config_dump_rows(&config)),
        Err(full_error) => {
            let default = dump_config(
                image,
                launch,
                embedded_patch_file,
                true,
                token,
                starting_processes,
                quitting,
            )
            .map_err(|default_error| {
                format!("{full_error}; 默认配置转储也失败: {default_error}")
            })?;
            let mut rows = parse_config_dump_rows(&default);
            rows.extend(user_patch_rows(&launch.profile, launch.dsh_home.as_deref()));
            Ok(rows)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "# == @deepseek-ai/dsh-bundle-base\n- id: official-core\n  name: '@deepseek-ai/plugin-core'\n# == third-party-bundle\n- id: old-market-plugin\n  name: '@legacy/old-market-plugin'\n# == /home/me/.dsh/cordis.patch.yml\n- id: user-added\n  name: 'file:///home/me/plugin.js'\n# == /tmp/embedded.patch.yml\n- id: embedded-client\n  name: 'file:///tmp/embedded.js'\n- id: harnessdock-client-runtime-compat\n  name: 'file:///tmp/compat.js'\n- id: harness-shell\n  name: 'file:///tmp/shell.js'\n";

    #[test]
    pub fn recovery_never_targets_official_or_embedded_rows() {
        let rows = parse_config_dump_rows(DUMP);
        let candidates = recovery_candidates(&rows);
        assert_eq!(
            candidates
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["old-market-plugin", "user-added"]
        );
    }

    #[test]
    pub fn diagnostic_attribution_keeps_full_external_quarantine_set() {
        let rows = parse_config_dump_rows(DUMP);
        let (selected, suspected, reason) =
            recovery_plan(&rows, "failed to load @legacy/old-market-plugin");
        assert_eq!(selected.len(), 2);
        assert_eq!(suspected, vec!["old-market-plugin"]);
        assert_eq!(reason, "diagnostic-match");
    }

    #[test]
    fn decode_yaml_scalar_unwraps_double_and_single_quotes() {
        assert_eq!(decode_yaml_scalar(r#""hello world""#), "hello world");
        assert_eq!(decode_yaml_scalar(r#""it is fine""#), "it is fine");
        assert_eq!(decode_yaml_scalar("'single quoted'"), "single quoted");
        assert_eq!(decode_yaml_scalar("'plain'"), "plain");
    }

    #[test]
    fn decode_yaml_scalar_decodes_json_escapes_inside_double_quotes() {
        assert_eq!(decode_yaml_scalar(r#""line1\nline2""#), "line1\nline2");
        assert_eq!(decode_yaml_scalar(r#""path C:\x""#), "path C:\\x");
        assert_eq!(decode_yaml_scalar(r#""tab\there""#), "tab\there");
    }

    #[test]
    fn decode_yaml_scalar_unescapes_doubled_single_quotes() {
        assert_eq!(decode_yaml_scalar("'it''s fine'"), "it's fine");
        assert_eq!(decode_yaml_scalar("'a''b''c'"), "a'b'c");
    }

    #[test]
    fn decode_yaml_scalar_trims_and_passes_through_plain_scalars() {
        assert_eq!(decode_yaml_scalar("  spaced  "), "spaced");
        assert_eq!(decode_yaml_scalar("true"), "true");
        assert_eq!(decode_yaml_scalar("false"), "false");
        assert_eq!(decode_yaml_scalar("42"), "42");
        assert_eq!(decode_yaml_scalar("0.5"), "0.5");
        assert_eq!(decode_yaml_scalar("127.0.0.1:8080"), "127.0.0.1:8080");
        assert_eq!(decode_yaml_scalar(""), "");
    }

    #[test]
    fn decode_yaml_scalar_degrades_safely_on_malformed_quotes() {
        // Unmatched quotes fall through to the raw value instead of panicking.
        assert_eq!(decode_yaml_scalar("\"unterminated"), "\"unterminated");
        assert_eq!(decode_yaml_scalar("unterminated'"), "unterminated'");
        // A double-quoted value that is not valid JSON keeps its payload.
        assert_eq!(decode_yaml_scalar(r#""bad escape \q""#), "bad escape \\q");
    }

    #[test]
    fn is_official_source_recognises_deepseek_paths_and_backslash_writes() {
        assert!(is_official_source("@deepseek-ai/dsh-bundle-base"));
        assert!(is_official_source("@deepseek-ai/plugin-core"));
        assert!(is_official_source(
            "/opt/node_modules/@deepseek-ai/dsh-bundle-base"
        ));
        assert!(is_official_source(
            "C:\\deepseek\\node_modules\\@deepseek-ai\\plugin"
        ));
        assert!(!is_official_source("third-party-bundle"));
        assert!(!is_official_source("/home/me/.dsh/cordis.patch.yml"));
        assert!(!is_official_source("@deepseek/ai-not-official"));
        assert!(!is_official_source(""));
    }

    #[test]
    fn is_official_row_falls_back_to_the_declared_name() {
        let by_source = ConfigDumpRow {
            id: "x".into(),
            name: None,
            source: "@deepseek-ai/dsh-bundle-base".into(),
        };
        let by_name = ConfigDumpRow {
            id: "x".into(),
            name: Some("@deepseek-ai/plugin-core".into()),
            source: "/tmp/embedded.patch.yml".into(),
        };
        let by_windows_name = ConfigDumpRow {
            id: "x".into(),
            name: Some("C:\\runtime\\node_modules\\@deepseek-ai\\plugin-core".into()),
            source: "/tmp/embedded.patch.yml".into(),
        };
        let neither = ConfigDumpRow {
            id: "x".into(),
            name: Some("@legacy/old-market-plugin".into()),
            source: "third-party-bundle".into(),
        };
        assert!(is_official_row(&by_source));
        assert!(is_official_row(&by_name));
        assert!(is_official_row(&by_windows_name));
        assert!(!is_official_row(&neither));
    }

    #[test]
    fn basename_handles_both_separator_families() {
        assert_eq!(basename("a/b/c"), "c");
        assert_eq!(basename("a\\b\\c"), "c");
        assert_eq!(basename("mixed/separators\\here"), "here");
        assert_eq!(basename("single"), "single");
        assert_eq!(basename(""), "");
        assert_eq!(basename("trailing/"), "");
    }

    #[test]
    fn row_tokens_expose_id_source_and_name_parts() {
        let row = ConfigDumpRow {
            id: "my-plugin".into(),
            name: Some("/tmp/FOO/my-plugin.js".into()),
            source: "/tmp/dump.yml".into(),
        };
        assert_eq!(
            row_tokens(&row),
            vec![
                "my-plugin",
                "/tmp/dump.yml",
                "dump.yml",
                "/tmp/FOO/my-plugin.js",
                "my-plugin.js"
            ]
        );
        let unnamed = ConfigDumpRow {
            id: "bare".into(),
            name: None,
            source: "/home/me/.dsh/cordis.patch.yml".into(),
        };
        assert_eq!(
            row_tokens(&unnamed),
            vec!["bare", "/home/me/.dsh/cordis.patch.yml", "cordis.patch.yml"]
        );
    }

    #[test]
    fn diagnostic_matches_is_case_insensitive_and_uses_basenames() {
        let row = ConfigDumpRow {
            id: "my-plugin".into(),
            name: Some("/tmp/FOO/my-plugin.js".into()),
            source: "/tmp/dump.yml".into(),
        };
        assert!(diagnostic_matches(
            &row,
            "cannot find module '/tmp/foo/MY-PLUGIN.JS'"
        ));
        assert!(diagnostic_matches(&row, "MODULE_NOT_FOUND: my-plugin"));
        assert!(!diagnostic_matches(&row, "no such file: unrelated.txt"));
    }

    #[test]
    fn recovery_patch_ids_deduplicates_preserving_first_seen_order() {
        let ids = vec![
            "second".to_string(),
            "first".to_string(),
            "second".to_string(),
            "first".to_string(),
        ];
        // The BTreeSet is a de-duplication index only; output order follows the
        // first appearance in the candidate list, so operators see the order the
        // config dump reported.
        assert_eq!(
            recovery_patch_ids(&ids).expect("patch must build"),
            "- id: \"second\"\n  disabled: true\n- id: \"first\"\n  disabled: true\n"
        );
        assert_eq!(recovery_patch_ids(&[]).expect("empty patch"), "");
    }

    #[test]
    fn recovery_patch_emits_a_disabled_row_per_source_row() {
        let rows = vec![ConfigDumpRow {
            id: "only".into(),
            name: None,
            source: "third-party-bundle".into(),
        }];
        assert_eq!(
            recovery_patch(&rows).expect("patch must build"),
            "- id: \"only\"\n  disabled: true\n"
        );
    }

    #[test]
    fn parse_config_dump_rows_pairs_names_and_tracks_sources() {
        let rows = parse_config_dump_rows(DUMP);
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "official-core",
                "old-market-plugin",
                "user-added",
                "embedded-client",
                "harnessdock-client-runtime-compat",
                "harness-shell",
            ]
        );
        assert_eq!(rows[0].name.as_deref(), Some("@deepseek-ai/plugin-core"));
        assert_eq!(rows[0].source, "@deepseek-ai/dsh-bundle-base");
        assert_eq!(rows[3].source, "/tmp/embedded.patch.yml");
    }

    #[test]
    fn parse_config_dump_rows_strips_the_patch_annotation_from_sources() {
        let rows = parse_config_dump_rows(
            "# == /a/b.plugin.yml, patched by harnessdock\n- id: one\n  name: 'x'\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "/a/b.plugin.yml");
        assert_eq!(rows[0].id, "one");
    }

    #[test]
    fn parse_config_dump_rows_ignores_ids_before_any_source_header() {
        let rows = parse_config_dump_rows("- id: orphan\n  name: 'x'\n# == src\n- id: named\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "orphan");
        assert!(rows[0].source.is_empty());
        assert_eq!(rows[1].id, "named");
        assert_eq!(rows[1].source, "src");
        assert!(rows[1].name.is_none());
    }

    /// `user_patch_rows` reads the process DSH home when no explicit root is
    /// supplied, so the fixture test scopes the environment variable under a
    /// process-wide lock and restores it on drop even when an assertion panics.
    static DSH_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct DshHomeScope {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl DshHomeScope {
        fn enter(root: &Path) -> Self {
            let lock = DSH_HOME_LOCK
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let previous = std::env::var_os("DSH_HOME");
            std::env::set_var("DSH_HOME", root);
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for DshHomeScope {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var("DSH_HOME", previous),
                None => std::env::remove_var("DSH_HOME"),
            }
        }
    }

    #[test]
    fn user_patch_rows_reads_the_scoped_home_files() {
        let root = std::env::temp_dir().join("harnessdock-user-patch-fixture");
        let _ = fs::remove_dir_all(&root);
        let profile_dir = root.join("profiles").join("web");
        fs::create_dir_all(&profile_dir).expect("create fixture dirs");
        fs::write(
            profile_dir.join("cordis.patch.yml"),
            "- id: profile-plugin\n  name: 'file:///tmp/profile-plugin.js'\n",
        )
        .expect("write profile fixture");
        fs::write(
            root.join("cordis.patch.yml"),
            "- id: home-plugin\n  name: 'file:///tmp/home-plugin.js'\n",
        )
        .expect("write home fixture");

        let _scope = DshHomeScope::enter(&root);
        let rows = user_patch_rows("web", None);

        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["profile-plugin", "home-plugin"]);
        assert!(rows.iter().all(|row| !row.source.is_empty()));
        assert!(rows.iter().all(|row| row.name.is_some()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn user_patch_rows_follows_selected_profile_and_explicit_home() {
        let root = std::env::temp_dir().join("harnessdock-selected-profile-patch-fixture");
        let _ = fs::remove_dir_all(&root);
        let profile_dir = root.join("profiles").join("research");
        fs::create_dir_all(&profile_dir).expect("create selected profile fixture dirs");
        fs::write(
            profile_dir.join("cordis.patch.yml"),
            "- id: research-plugin\n  name: 'file:///tmp/research-plugin.js'\n",
        )
        .expect("write selected profile fixture");
        fs::write(
            root.join("cordis.patch.yml"),
            "- id: home-plugin\n  name: 'file:///tmp/home-plugin.js'\n",
        )
        .expect("write home fixture");

        let rows = user_patch_rows("research", Some(&root));
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["research-plugin", "home-plugin"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn user_patch_rows_is_empty_without_patch_files() {
        let root = std::env::temp_dir().join("harnessdock-user-patch-empty");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create empty fixture");

        let _scope = DshHomeScope::enter(&root);
        assert!(user_patch_rows("web", None).is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
