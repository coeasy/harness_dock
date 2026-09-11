//! Config-dump parsing and plugin-failure recovery planning.

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

    const DUMP: &str = "# == @deepseek-ai/dsh-bundle-base\n- id: official-core\n  name: '@deepseek-ai/plugin-core'\n# == third-party-bundle\n- id: old-market-plugin\n  name: '@legacy/old-market-plugin'\n# == /home/me/.dsh/cordis.patch.yml\n- id: user-added\n  name: 'file:///home/me/plugin.js'\n# == /tmp/embedded.patch.yml\n- id: embedded-client\n  name: 'file:///tmp/embedded.js'\n";

    #[test]
    fn recovery_never_targets_official_or_embedded_rows() {
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
    fn diagnostic_attribution_preserves_external_quarantine_set() {
        let rows = parse_config_dump_rows(DUMP);
        let (selected, suspected, reason) =
            recovery_plan(&rows, "failed to load @legacy/old-market-plugin");
        assert_eq!(selected.len(), 2);
        assert_eq!(suspected, vec!["old-market-plugin"]);
        assert_eq!(reason, "diagnostic-match");
    }

    #[test]
    fn patch_rows_follow_selected_profile_and_explicit_home() {
        let root =
            std::env::temp_dir().join(format!("harnessdock-profile-patch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let profile_dir = root.join("profiles").join("research");
        fs::create_dir_all(&profile_dir).unwrap();
        fs::write(
            profile_dir.join("cordis.patch.yml"),
            "- id: profile-plugin\n  name: 'file:///tmp/profile.js'\n",
        )
        .unwrap();
        fs::write(
            root.join("cordis.patch.yml"),
            "- id: home-plugin\n  name: 'file:///tmp/home.js'\n",
        )
        .unwrap();
        let rows = user_patch_rows("research", Some(&root));
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["profile-plugin", "home-plugin"]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_patch_ids_deduplicates() {
        let ids = vec![
            "second".to_string(),
            "first".to_string(),
            "second".to_string(),
        ];
        assert_eq!(
            recovery_patch_ids(&ids).unwrap(),
            "- id: \"second\"\n  disabled: true\n- id: \"first\"\n  disabled: true\n"
        );
    }
}
