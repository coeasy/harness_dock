use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Keep every packaged helper process attached to the GUI application without
/// creating a visible Windows console window. `windowsHide` is not available
/// to Rust's `std::process::Command`, so the native creation flag is required
/// for the bundled Node Runtime and Gateway sidecar.
pub(crate) fn configure_child_command(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Give every managed helper its own process group so shutdown can
        // terminate Node workers and any descendants as one unit.
        command.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // The process tree is terminated explicitly by process.rs. Keep the
        // helper hidden from users while preserving a separate group boundary.
        command.creation_flags(CREATE_NO_WINDOW | 0x0000_0200);
    }
}

/// The packaged dsh runtime currently follows `^22.19.0 || >=24.0.0`.
/// Keep this check in the native launcher for the explicit system-Node escape
/// hatch without ever downloading or installing another system-wide copy.
pub(crate) fn is_supported_node_version(raw: &str) -> bool {
    let version = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    let mut parts = version.split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(minor) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(_patch) = parts
        .next()
        .and_then(|part| part.split(|ch: char| !ch.is_ascii_digit()).next())
        .and_then(|part| part.parse::<u64>().ok())
    else {
        return false;
    };
    (major == 22 && minor >= 19) || major >= 24
}

fn command_output(command: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut child = Command::new(node_cli_path(command));
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_child_command(&mut child);
    child.output().ok().filter(|output| output.status.success()).map(|output| output.stdout)
}

fn is_usable_node(candidate: &Path) -> bool {
    candidate.is_file()
        && command_output(candidate, &["--version"])
            .map(|output| is_supported_node_version(&String::from_utf8_lossy(&output)))
            .unwrap_or(false)
}

fn path_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let locator = if cfg!(windows) { "where.exe" } else { "which" };
    if let Some(output) = command_output(Path::new(locator), &["node"]) {
        for line in String::from_utf8_lossy(&output)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let candidate = node_cli_path(&PathBuf::from(line));
            if !candidates.iter().any(|existing| existing == &candidate) {
                candidates.push(candidate);
            }
        }
    }
    candidates
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

/// Return a usable Node from PATH only when the caller has explicitly opted
/// into the system runtime. This probe never mutates PATH, downloads files, or
/// writes an installer/runtime directory.
pub(crate) fn find_usable_system_node() -> Option<PathBuf> {
    path_node_candidates()
        .into_iter()
        .find(|candidate| is_usable_node(candidate))
}

/// Full desktop packages are self-contained, so the pinned bundled Node is the
/// default trust and reproducibility boundary. A system Node participates only
/// through an explicit user/developer override:
///
/// - HARNESSDOCK_NODE_BIN=/absolute/path/to/node: try exactly that binary.
/// - HARNESSDOCK_USE_SYSTEM_NODE=1: probe PATH for a compatible Node.
///
/// Invalid or incompatible overrides fail closed to the bundled Node rather
/// than silently widening the search to other system binaries.
pub(crate) fn resolve_node(bundled: &Path) -> (PathBuf, &'static str) {
    if let Some(value) = env::var_os("HARNESSDOCK_NODE_BIN").filter(|value| !value.is_empty()) {
        let configured = node_cli_path(&PathBuf::from(value));
        return if is_usable_node(&configured) {
            (configured, "system")
        } else {
            (bundled.to_path_buf(), "bundled")
        };
    }

    if env::var("HARNESSDOCK_USE_SYSTEM_NODE").ok().as_deref() == Some("1") {
        return find_usable_system_node()
            .map(|path| (path, "system"))
            .unwrap_or_else(|| (bundled.to_path_buf(), "bundled"));
    }

    (bundled.to_path_buf(), "bundled")
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
    use super::{is_supported_node_version, strip_windows_verbatim_prefix};

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

    #[test]
    fn accepts_the_pinned_dsh_node_engine_range() {
        assert!(is_supported_node_version("v22.19.0"));
        assert!(is_supported_node_version("24.1.0"));
        assert!(!is_supported_node_version("v22.18.0"));
        assert!(!is_supported_node_version("v23.0.0"));
        assert!(!is_supported_node_version("node"));
    }
}