use serde::Serialize;
use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
};

fn embedded_runtime_root(program: &OsStr) -> Option<PathBuf> {
    let program = node_cli_path(Path::new(program));
    let name = program.file_name()?.to_string_lossy().to_ascii_lowercase();
    let root = if cfg!(windows) {
        if name != "node.exe" {
            return None;
        }
        program.parent()?.to_path_buf()
    } else {
        if name != "node" || program.parent()?.file_name()? != "bin" {
            return None;
        }
        program.parent()?.parent()?.to_path_buf()
    };
    if root.join("manifest.json").is_file() && root.join("tools").join("bin").is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Build the child-only execution environment for the immutable packaged
/// Runtime. The GUI process PATH is never modified. This keeps pnpm/plugin
/// management available to dsh descendants without leaking bundled tools into
/// unrelated Host processes.
fn configure_embedded_runtime_environment(command: &mut std::process::Command) {
    let Some(root) = embedded_runtime_root(command.get_program()) else {
        return;
    };
    let tool_bin = root.join("tools").join("bin");
    let node_bin = if cfg!(windows) {
        root
    } else {
        root.join("bin")
    };
    let current = env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![tool_bin, node_bin];
    entries.extend(env::split_paths(&current));
    if let Ok(joined) = env::join_paths(entries) {
        command.env("PATH", joined);
    }
}

/// Configure every managed helper process. Runtime descendants receive an
/// explicit ExecEnvironment; the Host process environment remains untouched.
pub(crate) fn configure_child_command(command: &mut std::process::Command) {
    configure_embedded_runtime_environment(command);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW | 0x0000_0200);
    }
}

/// Remove the Windows verbatim path prefix before handing a path to Node's
/// CLI/module loader. Node 24 currently mishandles \\?\\ paths as the main
/// script and reports EISDIR for a drive root such as C:\\.
#[cfg(any(windows, test))]
fn strip_windows_verbatim_prefix(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    raw.strip_prefix("\\\\?\\").unwrap_or(raw).to_string()
}

/// Tauri may return extended Windows paths. Keep filesystem access unchanged,
/// but pass ordinary Win32 paths to Node because Node's entry-point resolver
/// does not accept the verbatim \\?\\ prefix on affected releases.
pub(crate) fn node_cli_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        return PathBuf::from(strip_windows_verbatim_prefix(&path.to_string_lossy()));
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub surface: &'static str,
    pub runtime_mode: &'static str,
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        surface: if cfg!(mobile) { "mobile" } else { "desktop" },
        runtime_mode: if cfg!(mobile) { "remote" } else { "local" },
    }
}

#[cfg(test)]
mod tests {
    use super::strip_windows_verbatim_prefix;

    #[test]
    fn strips_node_incompatible_windows_verbatim_prefixes() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Program Files\HarnessDock\bin.js"),
            r"C:\Program Files\HarnessDock\bin.js"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\bin.js"),
            r"\\server\share\bin.js"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\HarnessDock\bin.js"),
            r"C:\HarnessDock\bin.js"
        );
    }
}
