use serde::{Deserialize, Serialize};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/coeasy/harness_dock/releases/latest";

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
