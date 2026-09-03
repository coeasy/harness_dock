use serde::{Deserialize, Serialize};
use std::cmp::Ordering as VersionOrdering;

#[cfg(not(mobile))]
use std::time::Duration;
#[cfg(not(mobile))]
use tauri::Manager;
#[cfg(not(mobile))]
use tauri_plugin_updater::UpdaterExt;

use crate::update_actor::UpdatePhase;

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

fn normalized_version(value: &str) -> String {
    value
        .trim()
        .strip_prefix(['v', 'V'])
        .unwrap_or(value.trim())
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

fn semantic_version(value: &str) -> Option<SemanticVersion> {
    let normalized = normalized_version(value);
    if normalized.is_empty() || normalized.matches('+').count() > 1 {
        return None;
    }
    let (without_build, build) = normalized
        .split_once('+')
        .map(|(version, build)| (version, Some(build)))
        .unwrap_or((&normalized, None));
    if build.is_some_and(|value| {
        value.is_empty() || !value.split('.').all(valid_semver_identifier)
    }) {
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
            let mut values = Vec::new();
            for value in raw.split('.') {
                if !valid_semver_identifier(value) {
                    return None;
                }
                if value.bytes().all(|byte| byte.is_ascii_digit()) {
                    values.push(PrereleaseIdentifier::Numeric(parse_numeric_identifier(value)?));
                } else {
                    values.push(PrereleaseIdentifier::Text(value.to_string()));
                }
            }
            values
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
            (PrereleaseIdentifier::Numeric(left), PrereleaseIdentifier::Numeric(right)) => left.cmp(right),
            (PrereleaseIdentifier::Numeric(_), PrereleaseIdentifier::Text(_)) => VersionOrdering::Less,
            (PrereleaseIdentifier::Text(_), PrereleaseIdentifier::Numeric(_)) => VersionOrdering::Greater,
            (PrereleaseIdentifier::Text(left), PrereleaseIdentifier::Text(right)) => left.cmp(right),
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
    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).trim().to_string();
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
        title: release.name.unwrap_or_else(|| "HarnessDock 最新版本".into()),
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
    })
}

#[cfg(not(mobile))]
struct UpdateActionGuard {
    app: tauri::AppHandle,
    failed: bool,
}

#[cfg(not(mobile))]
impl UpdateActionGuard {
    fn begin(app: &tauri::AppHandle) -> Result<Self, String> {
        app.state::<crate::AppState>()
            .update_actor
            .lock()
            .map_err(|_| "UpdateActor 状态锁已损坏。".to_string())?
            .begin()?;
        Ok(Self {
            app: app.clone(),
            failed: false,
        })
    }

    fn transition(&self, phase: UpdatePhase) {
        if let Ok(mut actor) = self.app.state::<crate::AppState>().update_actor.lock() {
            actor.transition(phase);
        }
    }

    fn fail(&mut self) {
        self.failed = true;
        if let Ok(mut actor) = self.app.state::<crate::AppState>().update_actor.lock() {
            actor.fail();
        }
    }
}

#[cfg(not(mobile))]
impl Drop for UpdateActionGuard {
    fn drop(&mut self) {
        if let Ok(mut actor) = self.app.state::<crate::AppState>().update_actor.lock() {
            if actor.phase() == UpdatePhase::Restarting {
                return;
            }
            if self.failed {
                actor.fail();
            } else {
                actor.finish();
            }
        }
    }
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<UpdateInstallResult, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Err("Android/iOS 暂不支持桌面客户端自动更新，请使用应用商店更新。".into());
    }

    #[cfg(not(mobile))]
    {
        if app
            .state::<crate::AppState>()
            .quitting
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("HarnessDock 正在退出，已拒绝自动更新。".into());
        }
        let mut action = UpdateActionGuard::begin(&app)?;
        crate::harness_window::show_splash(&app, "正在检查 GitHub 最新版本…");
        let release = match update_check().await {
            Ok(release) => release,
            Err(error) => {
                action.fail();
                crate::harness_window::hide_splash(&app);
                return Err(format!("GitHub 最新版本检查失败: {error}"));
            }
        };
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
            action.fail();
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 已发布 HarnessDock v{}，但安全自动安装未启用：发布签名公钥未配置。请打开发布页手动更新：{}",
                release.latest_version, release.release_url
            ));
        };
        let endpoint = match UPDATER_ENDPOINT.parse() {
            Ok(endpoint) => endpoint,
            Err(error) => {
                action.fail();
                crate::harness_window::hide_splash(&app);
                return Err(format!("自动更新地址无效: {error}"));
            }
        };
        crate::harness_window::show_splash(&app, "正在验证签名更新清单…");
        let updater = match app
            .updater_builder()
            .pubkey(public_key)
            .endpoints(vec![endpoint])
            .and_then(|builder| {
                builder
                    .timeout(Duration::from_secs(30))
                    .on_before_exit({
                        let shutdown_app = app.clone();
                        move || crate::stop_managed_processes(&shutdown_app)
                    })
                    .build()
            }) {
            Ok(updater) => updater,
            Err(error) => {
                action.fail();
                crate::harness_window::hide_splash(&app);
                return Err(format!("无法初始化安全更新服务: {error}"));
            }
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                action.fail();
                crate::harness_window::hide_splash(&app);
                return Err(format!(
                    "GitHub 已发现 v{}，但签名更新清单尚未同步。",
                    release.latest_version
                ));
            }
            Err(error) => {
                action.fail();
                crate::harness_window::hide_splash(&app);
                return Err(format!("安全更新检查失败: {error}"));
            }
        };
        let version = update.version.to_string();
        if normalized_version(&version) != normalized_version(&release.latest_version) {
            action.fail();
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 最新版本为 v{}，但签名更新清单为 v{}，版本不一致。",
                release.latest_version, version
            ));
        }
        action.transition(UpdatePhase::Downloading);
        crate::harness_window::show_splash(&app, "正在下载签名更新…");
        let progress_app = app.clone();
        let mut downloaded = 0_u64;
        if let Err(error) = update
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
        {
            action.fail();
            crate::harness_window::hide_splash(&app);
            return Err(format!("安全更新下载或安装失败: {error}"));
        }
        action.transition(UpdatePhase::Installing);
        crate::harness_window::show_splash(&app, "更新已安装，正在重启 HarnessDock…");
        action.transition(UpdatePhase::Restarting);
        app.state::<crate::AppState>()
            .quitting
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
    }

    #[test]
    fn semver_parser_rejects_ambiguous_versions() {
        assert!(semantic_version("0.2").is_none());
        assert!(semantic_version("0.2.00").is_none());
        assert!(semantic_version("0.2.0-beta.01").is_none());
        assert!(semantic_version("0.2.0+").is_none());
    }
}
