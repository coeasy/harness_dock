use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;

/// Schema v3 binds a quarantine record to both the dsh base version and the
/// effective Runtime launch scope. This prevents a record learned from one
/// profile/DSH_HOME tree from disabling plugins in another tree.
const SCHEMA_VERSION: u8 = 3;

/// Extract the `MAJOR.MINOR.PATCH` base version from a full SemVer-ish string
/// such as `0.1.2-rc.1` or `0.1.2`. Falls back to the input when it has no
/// prerelease/build suffix.
fn base_version(value: &str) -> String {
    let base = value.split(['-', '+']).next().unwrap_or(value);
    base.trim().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginQuarantineRecord {
    pub schema_version: u8,
    pub dsh_version: String,
    #[serde(default)]
    pub dsh_base_version: String,
    /// Stable identity of the profile plus effective DSH_HOME used when the
    /// failure was attributed. Empty only on legacy schema records.
    #[serde(default)]
    pub launch_scope: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub isolated_plugins: Vec<String>,
    pub suspected_plugins: Vec<String>,
    pub reason: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn valid_reason(reason: &str) -> bool {
    reason == "diagnostic-match" || reason == "ambiguous"
}

/// Whether a persisted record still applies to the current Runtime launch.
///
/// Schema v1/v2 records predate profile/DSH_HOME scoping. They are deliberately
/// invalidated once rather than being guessed into a possibly different plugin
/// tree. A fresh failure can immediately rebuild a v3 record for that scope.
fn record_applies(record: &PluginQuarantineRecord, dsh_version: &str, launch_scope: &str) -> bool {
    if record.schema_version != SCHEMA_VERSION {
        return false;
    }
    let expected_base = base_version(dsh_version);
    !expected_base.is_empty()
        && record.dsh_base_version == expected_base
        && !launch_scope.is_empty()
        && record.launch_scope == launch_scope
}

pub(crate) fn read(
    path: &Path,
    dsh_version: &str,
    launch_scope: &str,
) -> Option<PluginQuarantineRecord> {
    let record = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PluginQuarantineRecord>(&raw).ok());
    let Some(record) = record else {
        let _ = fs::remove_file(path);
        return None;
    };
    if !record_applies(&record, dsh_version, launch_scope)
        || record.expires_at <= now_secs()
        || record.isolated_plugins.is_empty()
        || !valid_reason(&record.reason)
    {
        let _ = fs::remove_file(path);
        return None;
    }
    Some(record)
}

fn commit_replace(tmp: &Path, path: &Path) -> Result<(), String> {
    match fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(first_error) if path.exists() => {
            // POSIX rename replaces an existing destination atomically, while
            // Windows commonly rejects that form. Retry through an explicit
            // destination removal only when an existing target is the reason
            // the direct atomic path could not be used.
            fs::remove_file(path).map_err(|error| {
                let _ = fs::remove_file(tmp);
                format!("无法替换旧的插件隔离状态: {error}; initial rename: {first_error}")
            })?;
            fs::rename(tmp, path).map_err(|error| {
                let _ = fs::remove_file(tmp);
                format!("无法提交新的插件隔离状态: {error}; initial rename: {first_error}")
            })
        }
        Err(error) => {
            let _ = fs::remove_file(tmp);
            Err(format!("无法提交插件隔离状态: {error}"))
        }
    }
}

pub(crate) fn write(
    path: &Path,
    dsh_version: &str,
    launch_scope: &str,
    isolated_plugins: Vec<String>,
    suspected_plugins: Vec<String>,
    reason: &str,
) -> Result<PluginQuarantineRecord, String> {
    if launch_scope.is_empty() {
        return Err("plugin quarantine requires a launch scope".into());
    }
    if isolated_plugins.is_empty() {
        return Err("plugin quarantine requires at least one plugin id".into());
    }
    if !valid_reason(reason) {
        return Err(format!("invalid plugin quarantine reason: {reason}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建插件隔离目录: {error}"))?;
    }
    let created_at = now_secs();
    let record = PluginQuarantineRecord {
        schema_version: SCHEMA_VERSION,
        dsh_version: dsh_version.to_string(),
        dsh_base_version: base_version(dsh_version),
        launch_scope: launch_scope.to_string(),
        created_at,
        expires_at: created_at.saturating_add(DEFAULT_TTL_SECS),
        isolated_plugins,
        suspected_plugins,
        reason: reason.to_string(),
    };
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    fs::write(&tmp, bytes).map_err(|error| format!("无法写入插件隔离临时文件: {error}"))?;
    commit_replace(&tmp, path)?;
    Ok(record)
}

pub(crate) fn clear(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除插件隔离状态: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE: &str = "profile=web\ndsh_home=/tmp/dsh-a";

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "harnessdock-quarantine-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    #[test]
    fn version_mismatch_invalidates_quarantine() {
        let root = test_root("version");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("plugin-quarantine.json");
        write(
            &file,
            "old",
            SCOPE,
            vec!["legacy-a".into(), "legacy-b".into()],
            vec!["legacy-a".into()],
            "diagnostic-match",
        )
        .unwrap();
        assert!(read(&file, "new", SCOPE).is_none());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quarantine_survives_prerelease_upgrade_in_same_launch_scope() {
        let root = test_root("prerelease-upgrade");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("plugin-quarantine.json");
        write(
            &file,
            "0.1.2-rc.1",
            SCOPE,
            vec!["bad-a".into()],
            vec!["bad-a".into()],
            "diagnostic-match",
        )
        .unwrap();
        assert_eq!(
            read(&file, "0.1.2", SCOPE)
                .expect("rc -> stable keeps quarantine in same scope")
                .isolated_plugins,
            vec!["bad-a"]
        );
        assert_eq!(
            read(&file, "0.1.2-rc.2", SCOPE)
                .expect("rc -> rc keeps quarantine in same scope")
                .isolated_plugins,
            vec!["bad-a"]
        );
        assert!(read(&file, "0.2.0", SCOPE).is_none());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn launch_scope_mismatch_invalidates_quarantine() {
        let root = test_root("scope");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("plugin-quarantine.json");
        write(
            &file,
            "0.1.5-rc.2",
            SCOPE,
            vec!["bad-a".into()],
            vec!["bad-a".into()],
            "diagnostic-match",
        )
        .unwrap();
        assert!(read(&file, "0.1.5-rc.2", "profile=web\ndsh_home=/tmp/dsh-b").is_none());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_unscoped_quarantine_is_invalidated_once() {
        let root = test_root("legacy-scope");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("plugin-quarantine.json");
        let now = now_secs();
        let legacy = PluginQuarantineRecord {
            schema_version: 2,
            dsh_version: "0.1.5-rc.1".into(),
            dsh_base_version: "0.1.5".into(),
            launch_scope: String::new(),
            created_at: now,
            expires_at: now.saturating_add(DEFAULT_TTL_SECS),
            isolated_plugins: vec!["bad-a".into()],
            suspected_plugins: vec!["bad-a".into()],
            reason: "diagnostic-match".into(),
        };
        fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(read(&file, "0.1.5-rc.2", SCOPE).is_none());
        assert!(!file.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn newer_quarantine_replaces_existing_record() {
        let root = test_root("replace");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("plugin-quarantine.json");
        write(
            &file,
            "same",
            SCOPE,
            vec!["plugin-a".into()],
            vec!["plugin-a".into()],
            "diagnostic-match",
        )
        .unwrap();
        let second = write(
            &file,
            "same",
            SCOPE,
            vec!["plugin-b".into()],
            vec!["plugin-b".into()],
            "ambiguous",
        )
        .unwrap();
        let persisted =
            read(&file, "same", SCOPE).expect("replacement quarantine should be readable");
        assert_eq!(persisted.isolated_plugins, vec!["plugin-b"]);
        assert_eq!(persisted.reason, "ambiguous");
        assert_eq!(persisted, second);
        let _ = fs::remove_dir_all(root);
    }
}
