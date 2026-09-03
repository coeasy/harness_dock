use serde::{Deserialize, Serialize};
use std::cmp::Ordering as VersionOrdering;

#[cfg(not(mobile))]
use std::time::Duration;

#[cfg(not(mobile))]
use std::sync::atomic::Ordering;
#[cfg(not(mobile))]
use tauri::Manager;
#[cfg(not(mobile))]
use tauri_plugin_updater::UpdaterExt;

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/coeasy/harness_dock/releases/latest";
const UPDATER_ENDPOINT: &str =
    "https://github.com/coeasy/harness_dock/releases/latest/download/latest.json";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub release_url: String,
    pub title: String,
    pub notes: String,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
    pub status: String,
    pub version: Option<String>,
}

#[cfg(not(mobile))]
struct UpdateActionGuard<'a>(&'a std::sync::atomic::AtomicBool);

#[cfg(not(mobile))]
impl Drop for UpdateActionGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn normalized_version(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('v')
        .or_else(|| value.strip_prefix('V'))
        .unwrap_or(value)
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PrereleaseIdentifier {
    Numeric(u64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticVersion {
    core: (u64, u64, u64),
    prerelease: Vec<PrereleaseIdentifier>,
}

fn parse_numeric_identifier(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if value.len() > 1 && value.starts_with('0') {
        return None;
    }
    value.parse().ok()
}

fn valid_semver_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_build_metadata(value: &str) -> bool {
    !value.is_empty() && value.split('.').all(valid_semver_identifier)
}

fn semantic_version(value: &str) -> Option<SemanticVersion> {
    let normalized = normalized_version(value);
    if normalized.is_empty() {
        return None;
    }
    if normalized.matches('+').count() > 1 {
        return None;
    }
    let (without_build, build) = normalized
        .split_once('+')
        .map(|(version, build)| (version, Some(build)))
        .unwrap_or((&normalized, None));
    if build.is_some_and(|value| !validate_build_metadata(value)) {
        return None;
    }

    let (core, prerelease_raw) = without_build
        .split_once('-')
        .map(|(core, prerelease)| (core, Some(prerelease)))
        .unwrap_or((without_build, None));
    let mut parts = core.split('.');
    let major = parse_numeric_identifier(parts.next()?)?;
    let minor = parse_numeric_identifier(parts.next()?)?;
    let patch = parse_numeric_identifier(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }

    let prerelease = match prerelease_raw {
        None => Vec::new(),
        Some(raw) => {
            if raw.is_empty() {
                return None;
            }
            let mut identifiers = Vec::new();
            for value in raw.split('.') {
                if !valid_semver_identifier(value) {
                    return None;
                }
                if value.bytes().all(|byte| byte.is_ascii_digit()) {
                    identifiers.push(PrereleaseIdentifier::Numeric(parse_numeric_identifier(
                        value,
                    )?));
                } else {
                    // SemVer prerelease identifiers are compared using ASCII
                    // lexical order and are case-sensitive. Do not normalize
                    // the case or Beta/RC ordering becomes incorrect.
                    identifiers.push(PrereleaseIdentifier::Text(value.to_string()));
                }
            }
            identifiers
        }
    };

    Some(SemanticVersion {
        core: (major, minor, patch),
        prerelease,
    })
}

fn compare_prerelease(
    left: &[PrereleaseIdentifier],
    right: &[PrereleaseIdentifier],
) -> VersionOrdering {
    if left.is_empty() && right.is_empty() {
        return VersionOrdering::Equal;
    }
    if left.is_empty() {
        return VersionOrdering::Greater;
    }
    if right.is_empty() {
        return VersionOrdering::Less;
    }

    for (left, right) in left.iter().zip(right.iter()) {
        let ordering = match (left, right) {
            (PrereleaseIdentifier::Numeric(left), PrereleaseIdentifier::Numeric(right)) => {
                left.cmp(right)
            }
            (PrereleaseIdentifier::Numeric(_), PrereleaseIdentifier::Text(_)) => {
                VersionOrdering::Less
            }
            (PrereleaseIdentifier::Text(_), PrereleaseIdentifier::Numeric(_)) => {
                VersionOrdering::Greater
            }
            (PrereleaseIdentifier::Text(left), PrereleaseIdentifier::Text(right)) => {
                left.cmp(right)
            }
        };
        if ordering != VersionOrdering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn compare_versions(left: &SemanticVersion, right: &SemanticVersion) -> VersionOrdering {
    match left.core.cmp(&right.core) {
        VersionOrdering::Equal => compare_prerelease(&left.prerelease, &right.prerelease),
        ordering => ordering,
    }
}

fn is_newer(latest: &str, current: &str) -> Result<bool, String> {
    let latest = semantic_version(latest)
        .ok_or_else(|| "更新服务返回了无效的 HarnessDock 版本号，已拒绝。".to_string())?;
    let current = semantic_version(current)
        .ok_or_else(|| "当前 HarnessDock 版本号无效，无法安全判断更新。".to_string())?;
    Ok(compare_versions(&latest, &current) == VersionOrdering::Greater)
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = reqwest::Client::builder()
        .user_agent(format!("HarnessDock/{current_version}"))
        .build()
        .map_err(|error| format!("无法创建更新检查请求: {error}"))?
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| format!("更新检查连接失败: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("更新服务返回 HTTP {}。", response.status()));
    }

    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|error| format!("更新信息格式无效: {error}"))?;
    if !release
        .html_url
        .starts_with("https://github.com/coeasy/harness_dock/releases/")
    {
        return Err("更新服务返回了非 HarnessDock 发布地址，已拒绝。".into());
    }
    if release.draft || release.prerelease {
        return Ok(UpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version.clone(),
            available: false,
            release_url: release.html_url,
            title: "暂无稳定更新".into(),
            notes: String::new(),
            published_at: release.published_at,
        });
    }

    let latest_version = release
        .tag_name
        .trim_start_matches(['v', 'V'])
        .trim()
        .to_string();
    let parsed_latest = semantic_version(&latest_version)
        .ok_or_else(|| "更新服务返回了无效的 HarnessDock 版本号，已拒绝。".to_string())?;
    if !parsed_latest.prerelease.is_empty() {
        return Err("GitHub 稳定 Release 使用了预发布版本号，已拒绝自动更新。".into());
    }
    Ok(UpdateInfo {
        available: is_newer(&latest_version, &current_version)?,
        current_version,
        latest_version,
        release_url: release.html_url,
        title: release
            .name
            .unwrap_or_else(|| "HarnessDock 最新版本".into()),
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
    })
}

/// Check and install a signed Tauri update, then restart the client.
///
/// The public key is intentionally supplied at build time. Until the release
/// pipeline publishes `latest.json` and a matching signature, this command
/// returns an explicit, actionable error instead of downloading an unsigned
/// installer or pretending that a manual release page is an automatic update.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<UpdateInstallResult, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 暂不支持桌面客户端自动更新，请使用应用商店更新。".into());
    }

    #[cfg(not(mobile))]
    {
        let state = app.state::<crate::AppState>();
        if state.quitting.load(Ordering::Acquire) {
            return Err("HarnessDock 正在退出，已拒绝自动更新。".into());
        }
        if state.web_action.swap(true, Ordering::AcqRel) {
            return Err("HarnessDock 正在处理另一个操作，请稍候。".into());
        }
        let _action = UpdateActionGuard(&state.web_action);
        crate::harness_window::show_splash(&app, "正在检查 GitHub 最新版本…");
        let release = update_check().await.map_err(|error| {
            crate::harness_window::hide_splash(&app);
            format!("GitHub 最新版本检查失败: {error}")
        })?;
        if !release.available {
            crate::harness_window::hide_splash(&app);
            return Ok(UpdateInstallResult {
                status: "latest".into(),
                version: Some(release.current_version),
            });
        }

        let Some(public_key) =
            option_env!("HARNESSDOCK_UPDATER_PUBLIC_KEY").filter(|value| !value.trim().is_empty())
        else {
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 已发布 HarnessDock v{}，但安全自动安装尚未启用：发布签名公钥未配置。请打开发布页手动更新：{}",
                release.latest_version, release.release_url
            ));
        };

        crate::harness_window::show_splash(&app, "正在准备签名更新…");
        let endpoint = UPDATER_ENDPOINT.parse().map_err(|error| {
            crate::harness_window::hide_splash(&app);
            format!("自动更新地址无效: {error}")
        })?;
        let updater = app
            .updater_builder()
            .pubkey(public_key)
            .endpoints(vec![endpoint])
            .map_err(|error| {
                crate::harness_window::hide_splash(&app);
                format!("无法配置安全更新服务: {error}")
            })?
            .timeout(Duration::from_secs(30))
            .on_before_exit({
                let shutdown_app = app.clone();
                move || crate::stop_managed_processes(&shutdown_app)
            })
            .build()
            .map_err(|error| {
                crate::harness_window::hide_splash(&app);
                format!("无法初始化安全更新服务: {error}")
            })?;

        let Some(update) = updater.check().await.map_err(|error| {
            crate::harness_window::hide_splash(&app);
            format!("安全更新检查失败: {error}")
        })?
        else {
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 已发现 v{}，但签名更新清单尚未同步，暂不安装未知版本。",
                release.latest_version
            ));
        };

        let version = update.version.to_string();
        if normalized_version(&version) != normalized_version(&release.latest_version) {
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 最新版本为 v{}，但签名更新清单为 v{}，版本不一致，暂不安装。",
                release.latest_version, version
            ));
        }
        crate::harness_window::show_splash(&app, "正在下载签名更新…");
        let progress_app = app.clone();
        let mut downloaded = 0_u64;
        update
            .download_and_install(
                move |chunk_length, content_length| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    let status = content_length
                        .filter(|length| *length > 0)
                        .map(|length| {
                            format!(
                                "正在下载签名更新… {}%",
                                downloaded.saturating_mul(100) / length
                            )
                        })
                        .unwrap_or_else(|| "正在下载签名更新…".into());
                    crate::harness_window::show_splash(&progress_app, &status);
                },
                || {},
            )
            .await
            .map_err(|error| {
                crate::harness_window::hide_splash(&app);
                format!("安全更新下载或安装失败: {error}")
            })?;

        crate::harness_window::show_splash(&app, "更新已安装，正在重启 HarnessDock…");
        // The global ExitRequested guard protects WebView transitions from an
        // accidental process exit. An updater restart is the one intentional
        // exception, so open the same explicit quit gate before handing off to
        // Tauri's restart implementation.
        state.quitting.store(true, Ordering::SeqCst);
        crate::stop_managed_processes(&app);
        crate::wait_for_managed_processes(app.clone()).await;
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_stable_release_supersedes_same_core_prerelease() {
        assert!(is_newer("0.2.0", "0.2.0-beta.1").unwrap());
        assert!(!is_newer("0.2.0-beta.1", "0.2.0").unwrap());
    }

    #[test]
    fn semver_numeric_and_text_prerelease_identifiers_follow_precedence() {
        assert!(is_newer("0.2.0-beta.11", "0.2.0-beta.2").unwrap());
        assert!(is_newer("0.2.0-beta", "0.2.0-2").unwrap());
        assert!(is_newer("0.2.0-beta.2", "0.2.0-beta").unwrap());
        assert!(is_newer("0.2.0-beta", "0.2.0-Beta").unwrap());
    }

    #[test]
    fn semver_build_metadata_does_not_change_update_precedence() {
        assert!(!is_newer("0.2.0+release.2", "0.2.0+release.1").unwrap());
        assert!(is_newer("0.2.10", "0.2.9").unwrap());
    }

    #[test]
    fn semver_parser_rejects_invalid_or_ambiguous_versions() {
        assert!(semantic_version("0.2").is_none());
        assert!(semantic_version("0.2.00").is_none());
        assert!(semantic_version("0.2.0-beta.01").is_none());
        assert!(semantic_version("0.2.0+").is_none());
        assert!(semantic_version("0.2.0+build..1").is_none());
        assert!(semantic_version("0.2.0+build+extra").is_none());
        assert!(semantic_version("release-0.2.0").is_none());
    }
}
