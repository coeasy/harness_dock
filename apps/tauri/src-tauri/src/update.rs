use serde::{Deserialize, Serialize};

#[cfg(not(mobile))]
use std::time::Duration;

#[cfg(not(mobile))]
use tauri_plugin_updater::UpdaterExt;
#[cfg(not(mobile))]
use std::sync::atomic::Ordering;
#[cfg(not(mobile))]
use tauri::Manager;

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
    value.trim().trim_start_matches('v').to_ascii_lowercase()
}

fn version_tuple(value: &str) -> Option<(u64, u64, u64)> {
    let normalized = normalized_version(value);
    let mut parts = normalized.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.split('-').next()?.parse().ok()?,
    ))
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (version_tuple(latest), version_tuple(current)) {
        (Some(latest), Some(current)) => latest > current,
        _ => normalized_version(latest) != normalized_version(current),
    }
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
    if !release.html_url.starts_with("https://github.com/coeasy/harness_dock/releases/") {
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

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    Ok(UpdateInfo {
        available: is_newer(&latest_version, &current_version),
        current_version,
        latest_version,
        release_url: release.html_url,
        title: release.name.unwrap_or_else(|| "HarnessDock 最新版本".into()),
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
pub async fn update_install(
    app: tauri::AppHandle,
) -> Result<UpdateInstallResult, String> {
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

        let Some(public_key) = option_env!("HARNESSDOCK_UPDATER_PUBLIC_KEY")
            .filter(|value| !value.trim().is_empty())
        else {
            crate::harness_window::hide_splash(&app);
            return Err(format!(
                "GitHub 已发布 HarnessDock v{}，但安全自动安装尚未启用：发布签名公钥未配置。请打开发布页手动更新：{}",
                release.latest_version, release.release_url
            ));
        };

        crate::harness_window::show_splash(&app, "正在准备签名更新…");
        let endpoint = UPDATER_ENDPOINT
            .parse()
            .map_err(|error| {
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

        let Some(update) = updater
            .check()
            .await
            .map_err(|error| {
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
        app.restart();
    }
}
