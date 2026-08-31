use serde::Serialize;

/// Keep every packaged helper process attached to the GUI application without
/// creating a visible Windows console window. `windowsHide` is not available
/// to Rust's `std::process::Command`, so the native creation flag is required
/// for the bundled Node Runtime and Gateway sidecar.
pub(crate) fn configure_child_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
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
