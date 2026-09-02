use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::{SystemTime, UNIX_EPOCH}};

const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginQuarantineRecord {
    pub schema_version: u8,
    pub dsh_version: String,
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

pub(crate) fn read(path: &Path, dsh_version: &str) -> Option<PluginQuarantineRecord> {
    let record = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PluginQuarantineRecord>(&raw).ok());
    let Some(record) = record else {
        let _ = fs::remove_file(path);
        return None;
    };
    if record.schema_version != 1
        || record.dsh_version != dsh_version
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
    isolated_plugins: Vec<String>,
    suspected_plugins: Vec<String>,
    reason: &str,
) -> Result<PluginQuarantineRecord, String> {
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
        schema_version: 1,
        dsh_version: dsh_version.to_string(),
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
            vec!["legacy-a".into(), "legacy-b".into()],
            vec!["legacy-a".into()],
            "diagnostic-match",
        ).unwrap();
        assert!(read(&file, "new").is_none());
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
            vec!["plugin-a".into()],
            vec!["plugin-a".into()],
            "diagnostic-match",
        ).unwrap();
        let second = write(
            &file,
            "same",
            vec!["plugin-b".into()],
            vec!["plugin-b".into()],
            "ambiguous",
        ).unwrap();
        let persisted = read(&file, "same").expect("replacement quarantine should be readable");
        assert_eq!(persisted.isolated_plugins, vec!["plugin-b"]);
        assert_eq!(persisted.reason, "ambiguous");
        assert_eq!(persisted, second);
        let _ = fs::remove_dir_all(root);
    }
}
