use serde::Serialize;

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
