use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::Url;

const HEALTH_PATH: &str = "/api/harnessdock/health";
const PAIR_PATH: &str = "/api/harnessdock/pair";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHealth {
    pub ok: bool,
    pub provider: Option<String>,
    pub app_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    code: &'a str,
    device_name: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub connect_url: String,
    pub expires_at: String,
}

fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

fn normalize_gateway_origin(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Gateway 地址不是有效 URL。".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Gateway 地址不能包含用户名或密码。".into());
    }
    let host = url.host_str().ok_or_else(|| "Gateway 地址缺少主机名。".to_string())?;
    let secure = url.scheme() == "https";
    let loopback_dev = url.scheme() == "http" && is_loopback(host);
    if !secure && !loopback_dev {
        return Err("远程 Gateway 必须使用 HTTPS；HTTP 仅允许 localhost/loopback 开发环境。".into());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Gateway 地址必须是 origin 根地址，不能包含路径。".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Gateway 地址不能包含 query 或 fragment。".into());
    }
    url.set_path("/");
    Ok(url)
}

fn endpoint(base: &Url, path: &str) -> Result<Url, String> {
    base.join(path).map_err(|_| "无法构造 Gateway API 地址。".to_string())
}

#[tauri::command]
pub async fn gateway_health(base_url: String) -> Result<GatewayHealth, String> {
    let base = normalize_gateway_origin(&base_url)?;
    let response = reqwest::Client::new()
        .get(endpoint(&base, HEALTH_PATH)?)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("Gateway 连接失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Gateway health 返回 HTTP {}。", response.status()));
    }
    response.json::<GatewayHealth>().await.map_err(|error| format!("Gateway health 响应无效: {error}"))
}

#[tauri::command]
pub async fn pair_gateway(base_url: String, code: String, device_name: String) -> Result<PairResponse, String> {
    let base = normalize_gateway_origin(&base_url)?;
    let normalized_code: String = code.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if normalized_code.len() != 8 {
        return Err("配对码必须为 8 位数字。".into());
    }
    let name = device_name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("设备名称必须为 1-80 个字符。".into());
    }

    let response = reqwest::Client::new()
        .post(endpoint(&base, PAIR_PATH)?)
        .json(&PairRequest { code: &normalized_code, device_name: name })
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| format!("Gateway 配对请求失败: {error}"))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("配对码无效或已过期。".into());
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err("配对尝试过于频繁，请稍后重试。".into());
    }
    if !response.status().is_success() {
        return Err(format!("Gateway 配对返回 HTTP {}。", response.status()));
    }

    let paired = response.json::<PairResponse>().await.map_err(|error| format!("Gateway 配对响应无效: {error}"))?;
    let connect = Url::parse(&paired.connect_url).map_err(|_| "Gateway 返回了无效连接 URL。".to_string())?;
    if connect.origin() != base.origin() {
        return Err("Gateway 返回了跨 origin 的连接 URL，已拒绝。".into());
    }
    if connect.scheme() != "https" && !(connect.scheme() == "http" && connect.host_str().is_some_and(is_loopback)) {
        return Err("Gateway 返回了不安全的连接 URL，已拒绝。".into());
    }
    Ok(paired)
}
