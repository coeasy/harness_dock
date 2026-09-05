//! Runtime image resolution and private working-directory plumbing.


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


pub fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|error| format!("无法解析应用资源 {relative}: {error}"))
}

pub fn quarantine_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugin-quarantine.v1.json"))
        .map_err(|error| format!("无法解析插件隔离目录: {error}"))
}

pub fn node_path(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        root.join("node.exe")
    } else {
        root.join("bin").join("node")
    }
}

pub fn dsh_path(root: &Path) -> PathBuf {
    root.join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

pub fn load_runtime_image(app: &AppHandle) -> Result<RuntimeImage, String> {
    // The desktop candidate already validates the complete sealed Runtime image
    // before packaging. Normal application startup must not perform a second
    // Node/dsh filesystem preflight. Resolve the packaged paths and the minimal
    // immutable metadata needed for generation binding, then spawn directly.
    // If an installed image is actually corrupt, Command::spawn/readiness will
    // fail through the normal recovery path instead of presenting a Node check.
    let root = platform::node_cli_path(&resource_path(app, "dsh-runtime")?);
    let node = node_path(&root);
    let dsh = dsh_path(&root);
    let manifest_path = root.join("manifest.json");
    let origin_path = resource_path(app, "origin.json")?;

    let manifest: RuntimeManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("无法读取 Runtime manifest.json: {error}"))?,
    )
    .map_err(|error| format!("Runtime manifest.json 无效: {error}"))?;
    let image_identity = manifest
        .image_identity
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Runtime manifest 缺少 sealed imageIdentity。".to_string())?;
    let origin: OriginInfo = serde_json::from_str(
        &fs::read_to_string(&origin_path)
            .map_err(|error| format!("无法读取 origin.json: {error}"))?,
    )
    .map_err(|error| format!("origin.json 无效: {error}"))?;

    Ok(RuntimeImage {
        root,
        node,
        dsh,
        origin,
        image_identity,
    })
}

pub fn work_dir() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("harnessdock-tauri-{}-{nonce}", std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&dir)
            .map_err(|error| format!("无法创建私有 Runtime 临时目录: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(&dir).map_err(|error| format!("无法创建 Runtime 临时目录: {error}"))?;
    }
    Ok(dir)
}

pub fn dsh_home_path() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".dsh"))
        })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    pub fn runtime_work_dir_is_private_on_unix() {
        use super::work_dir;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = work_dir().unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let _ = fs::remove_dir_all(dir);
    }
}
