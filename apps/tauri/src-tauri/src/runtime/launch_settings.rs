//! Persistent dsh launch settings and the validated launch specification.
//!
//! The sealed Runtime image remains authoritative. Users may choose the dsh
//! profile and DSH_HOME that the bundled launcher receives, but cannot replace
//! the bundled Node/dsh executable through this surface.

use super::*;

pub const DEFAULT_PROFILE: &str = "web";
const SETTINGS_FILE: &str = "runtime-launch.v1.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeStartupPolicy {
    /// Normal HarnessDock behavior: try the selected profile, honour a valid
    /// quarantine, attribute startup failures, then fall back to Rescue Web.
    Auto,
    /// Start the selected profile exactly once. Useful for diagnosing custom
    /// profiles because HarnessDock does not mask the first startup failure.
    Direct,
    /// Start the shipped Web application while isolating all external/user
    /// plugin rows for this Runtime generation. The effective DSH_HOME is kept
    /// when its config can be inventoried so model/settings state remains
    /// available; an unreadable config falls back to a private rescue home.
    Safe,
}

impl Default for RuntimeStartupPolicy {
    fn default() -> Self {
        Self::Auto
    }
}

impl RuntimeStartupPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Direct => "direct",
            Self::Safe => "safe",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeLaunchSettings {
    /// `dsh --profile <name>`. Defaults to the shipped web profile.
    pub profile: String,
    /// Optional explicit DSH_HOME. `None` preserves dsh's normal environment /
    /// platform default resolution.
    pub dsh_home: Option<String>,
    /// Recovery policy applied by HarnessDock around the selected profile.
    pub startup_policy: RuntimeStartupPolicy,
}

impl Default for RuntimeLaunchSettings {
    fn default() -> Self {
        Self {
            profile: DEFAULT_PROFILE.into(),
            dsh_home: None,
            startup_policy: RuntimeStartupPolicy::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeLaunchSpec {
    pub profile: String,
    pub dsh_home: Option<PathBuf>,
    pub startup_policy: RuntimeStartupPolicy,
}

fn validate_profile_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value == "node_modules"
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(format!("无效 dsh profile 名称: {value:?}"));
    }
    Ok(())
}

fn normalize_settings(
    mut settings: RuntimeLaunchSettings,
) -> Result<RuntimeLaunchSettings, String> {
    settings.profile = settings.profile.trim().to_string();
    validate_profile_name(&settings.profile)?;

    settings.dsh_home = match settings.dsh_home.take() {
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                None
            } else {
                let path = PathBuf::from(&value);
                if !path.is_absolute() {
                    return Err("DSH_HOME 必须使用绝对路径；留空可使用 dsh 默认路径。".into());
                }
                Some(value)
            }
        }
        None => None,
    };
    Ok(settings)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|error| format!("无法解析 Runtime 启动配置目录: {error}"))
}

fn commit_replace(tmp: &Path, path: &Path) -> Result<(), String> {
    match fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(first_error) if path.exists() => {
            fs::remove_file(path).map_err(|error| {
                let _ = fs::remove_file(tmp);
                format!("无法替换旧 Runtime 启动配置: {error}; initial rename: {first_error}")
            })?;
            fs::rename(tmp, path).map_err(|error| {
                let _ = fs::remove_file(tmp);
                format!("无法提交 Runtime 启动配置: {error}; initial rename: {first_error}")
            })
        }
        Err(error) => {
            let _ = fs::remove_file(tmp);
            Err(format!("无法提交 Runtime 启动配置: {error}"))
        }
    }
}

fn save_runtime_launch_settings(
    app: &AppHandle,
    settings: &RuntimeLaunchSettings,
) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Runtime 启动配置目录: {error}"))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&tmp, bytes)
        .map_err(|error| format!("无法写入 Runtime 启动配置临时文件: {error}"))?;
    commit_replace(&tmp, &path)
}

pub fn load_runtime_launch_settings(app: &AppHandle) -> RuntimeLaunchSettings {
    let path = match settings_path(app) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Runtime launch settings path unavailable; using defaults: {error}");
            return RuntimeLaunchSettings::default();
        }
    };
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RuntimeLaunchSettings::default();
        }
        Err(error) => {
            eprintln!("Runtime launch settings unreadable; using defaults: {error}");
            return RuntimeLaunchSettings::default();
        }
    };
    match serde_json::from_str::<RuntimeLaunchSettings>(&raw)
        .map_err(|error| error.to_string())
        .and_then(normalize_settings)
    {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("Runtime launch settings invalid; using defaults: {error}");
            RuntimeLaunchSettings::default()
        }
    }
}

/// Leaving Rescue Web is an explicit user action. If Rescue Web was selected
/// as the persisted startup policy, restore it to Auto before the normal
/// restart; otherwise a successful repair would immediately re-enter rescue on
/// the next generation or next application launch. Direct/Auto preferences are
/// preserved because neither one forces plugin isolation.
pub fn restore_normal_startup_policy(app: &AppHandle) -> Result<RuntimeLaunchSettings, String> {
    let mut settings = load_runtime_launch_settings(app);
    if settings.startup_policy == RuntimeStartupPolicy::Safe {
        settings.startup_policy = RuntimeStartupPolicy::Auto;
        save_runtime_launch_settings(app, &settings)?;
    }
    Ok(settings)
}

pub fn resolve_runtime_launch_spec(app: &AppHandle) -> RuntimeLaunchSpec {
    let settings = load_runtime_launch_settings(app);
    RuntimeLaunchSpec {
        profile: settings.profile,
        dsh_home: settings.dsh_home.map(PathBuf::from),
        startup_policy: settings.startup_policy,
    }
}

#[tauri::command]
pub fn runtime_launch_settings_get(app: AppHandle) -> RuntimeLaunchSettings {
    load_runtime_launch_settings(&app)
}

#[tauri::command]
pub fn runtime_launch_settings_set(
    app: AppHandle,
    settings: RuntimeLaunchSettings,
) -> Result<RuntimeLaunchSettings, String> {
    let settings = normalize_settings(settings)?;
    save_runtime_launch_settings(&app, &settings)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_web_auto_and_inherited_home() {
        let settings = RuntimeLaunchSettings::default();
        assert_eq!(settings.profile, "web");
        assert_eq!(settings.dsh_home, None);
        assert_eq!(settings.startup_policy, RuntimeStartupPolicy::Auto);
    }

    #[test]
    fn profile_validation_matches_upstream_single_component_contract() {
        for value in ["web", "acp", "headless", "sdk", "sdk-minimal", "my-profile"] {
            assert!(validate_profile_name(value).is_ok(), "{value}");
        }
        for value in ["", ".", "..", "node_modules", "a/b", "a\\b", "bad\nname"] {
            assert!(validate_profile_name(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn relative_dsh_home_is_rejected() {
        let settings = RuntimeLaunchSettings {
            dsh_home: Some("relative/home".into()),
            ..RuntimeLaunchSettings::default()
        };
        assert!(normalize_settings(settings).is_err());
    }
}
