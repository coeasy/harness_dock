use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};

use crate::{platform, process as process_control, AppState};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayReady {
    schema_version: u8,
    pid: u32,
    admin_url: String,
    admin_token: String,
    local_url: String,
    public_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDeviceInfo {
    id: String,
    name: String,
    paired_at: String,
    last_seen_at: String,
    session_expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHostStatus {
    running: bool,
    local_url: Option<String>,
    public_url: Option<String>,
    devices: Vec<GatewayDeviceInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPairingTicket {
    code: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct RevokeResponse {
    revoked: bool,
}

#[derive(Debug, Deserialize)]
struct RevokeAllResponse {
    revoked: usize,
}

pub(crate) struct GatewayProcess {
    child: Child,
    stopped: bool,
    registration: process_control::StartingProcessGuard,
    work_dir: PathBuf,
    ready: GatewayReady,
}

impl GatewayProcess {
    fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.stopped = true;
                false
            }
            Ok(None) => true,
            Err(error) => {
                eprintln!("Unable to inspect Gateway sidecar process: {error}");
                false
            }
        }
    }

    fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            process_control::stop_child_tree(&mut self.child);
        }
        let _ = fs::remove_dir_all(&self.work_dir);
    }
}

impl Drop for GatewayProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn work_dir() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("harnessdock-gateway-{}-{nonce}", std::process::id()));

    // The Gateway ready file contains its bearer-style admin token and the log
    // can contain local Runtime diagnostics. Create a fresh private directory
    // instead of relying on the process umask or reusing an existing path.
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&dir)
            .map_err(|error| format!("无法创建私有 Gateway 临时目录: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(&dir).map_err(|error| format!("无法创建 Gateway 临时目录: {error}"))?;
    }
    Ok(dir)
}

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|error| format!("无法解析 Gateway 资源 {relative}: {error}"))
}

fn gateway_ready_snapshot(state: &State<'_, AppState>) -> Result<Option<GatewayReady>, String> {
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    let dead = guard
        .as_mut()
        .map(|process| !process.is_alive())
        .unwrap_or(false);
    if dead {
        let mut process = guard.take().expect("dead Gateway process disappeared");
        drop(guard);
        process.stop();
        return Ok(None);
    }
    Ok(guard.as_ref().map(|process| process.ready.clone()))
}

struct GatewayStartGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for GatewayStartGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn claim_gateway_start(state: &State<'_, AppState>) -> Result<GatewayStartGuard, String> {
    let starting = Arc::clone(&state.gateway_starting);
    if starting.swap(true, Ordering::AcqRel) {
        return Err("Gateway 正在处理另一个启动操作，请稍候再试。".into());
    }
    let claim = GatewayStartGuard(starting);
    if state.quitting.load(Ordering::Acquire)
        || state.runtime_restarting.load(Ordering::Acquire)
        || state.runtime_stopping.load(Ordering::Acquire)
    {
        return Err("Runtime 正在处理生命周期操作，暂时无法启动 Gateway。".into());
    }
    Ok(claim)
}

fn begin_gateway_start(state: &State<'_, AppState>) -> Result<Option<GatewayReady>, String> {
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    if let Some(process) = guard.as_mut() {
        if process.is_alive() {
            let ready = process.ready.clone();
            return Ok(Some(ready));
        }
        let mut process = guard.take().expect("dead Gateway process disappeared");
        drop(guard);
        process.stop();
        // The dead process has been removed; the caller owns the start guard.
        return Ok(None);
    }
    Ok(None)
}

fn required_gateway_ready(state: &State<'_, AppState>) -> Result<GatewayReady, String> {
    if crate::runtime::status_snapshot(&*state).app_url.is_none() {
        // A Gateway without its local authenticated upstream is not a usable
        // service. Clean the sidecar here as well as in the Runtime observer
        // so status, pairing and revoke commands cannot operate on orphaned
        // Gateway state between two lifecycle observations.
        stop_managed(&state.gateway);
        return Err("请先启动本地 Runtime，再使用 Mobile Gateway。".into());
    }
    gateway_ready_snapshot(state)?.ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())
}

fn stop_managed_if_matches(gateway: &Mutex<Option<GatewayProcess>>, expected: &GatewayReady) {
    let process = gateway
        .lock()
        .ok()
        .and_then(|mut guard| {
            let matches = guard.as_ref().is_some_and(|current| {
                current.ready.pid == expected.pid && current.ready.admin_token == expected.admin_token
            });
            if matches { guard.take() } else { None }
        });
    if let Some(mut process) = process {
        process.stop();
    }
}

fn runtime_gateway_inputs(state: &State<'_, AppState>) -> Result<(PathBuf, String), String> {
    let status = crate::runtime::status_snapshot(&*state);
    if status.app_url.is_none() {
        return Err("请先启动本地 Runtime，再启动 Mobile Gateway。".into());
    }
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "请先启动本地 Runtime，再启动 Mobile Gateway。".to_string())?;
    Ok(runtime.gateway_inputs())
}

fn public_gateway_diagnostic(raw: &str) -> String {
    let safe = raw
        .lines()
        .filter_map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("http://")
                || lower.contains("https://")
                || lower.contains("token")
                || lower.contains("authorization")
                || lower.contains("bearer")
                || lower.contains("secret")
                || lower.contains("upstream_url")
            {
                return None;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(500).collect::<String>())
            }
        })
        .take(24)
        .collect::<Vec<_>>();
    if safe.is_empty() {
        "Gateway sidecar 启动失败；敏感 URL/令牌已从用户可见诊断中隐藏。".into()
    } else {
        safe.join("\n")
    }
}

fn validated_gateway_port(local_port: Option<u16>) -> Result<u16, String> {
    let port = local_port.unwrap_or(43137);
    if port < 1024 {
        return Err("Gateway 本地端口必须在 1024-65535 之间，避免系统保留端口和管理员权限要求。".into());
    }
    Ok(port)
}

fn validated_public_gateway_url(public_url: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = public_url else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if !is_public_gateway_url(value) {
        return Err("Gateway 公网地址必须是 HTTPS 根地址（例如 https://gateway.example.com/）；仅本机调试允许 http://127.0.0.1:端口/。地址不能包含账号、密码、路径、查询参数或片段。".into());
    }
    let normalized = reqwest::Url::parse(value)
        .map_err(|error| format!("Gateway 公网地址无效: {error}"))?
        .to_string();
    Ok(Some(normalized))
}

fn spawn_sidecar(
    node: PathBuf,
    sidecar: PathBuf,
    upstream_url: String,
    public_url: Option<String>,
    local_port: u16,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &AtomicBool,
) -> Result<GatewayProcess, String> {
    if !node.is_file() {
        return Err(format!("Gateway Node Runtime 不存在: {}", node.display()));
    }
    if !sidecar.is_file() {
        return Err(format!("Gateway sidecar 未打包: {}", sidecar.display()));
    }
    let dir = work_dir()?;
    let ready_file = dir.join("ready.json");
    let log_file = dir.join("gateway.log");
    let stdout = match fs::File::create(&log_file) {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("无法创建 Gateway 日志: {error}"));
        }
    };
    let stderr = match stdout.try_clone() {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("无法复制 Gateway 日志句柄: {error}"));
        }
    };
    let mut command = Command::new(node);
    command
        .arg(sidecar)
        .env("HARNESSDOCK_SIDECAR_UPSTREAM_URL", upstream_url)
        .env("HARNESSDOCK_SIDECAR_READY_FILE", &ready_file)
        .env("HARNESSDOCK_GATEWAY_BIND", "127.0.0.1")
        .env("HARNESSDOCK_GATEWAY_PORT", local_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(value) = public_url.as_deref() {
        command.env("HARNESSDOCK_GATEWAY_PUBLIC_URL", value);
    }
    platform::configure_child_command(&mut command);
    let (mut child, registration) = match process_control::spawn_registered(&mut command, starting_processes, quitting) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("无法启动 Gateway sidecar: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if quitting.load(Ordering::Acquire) {
            process_control::stop_child_tree(&mut child);
            registration.complete();
            let _ = fs::remove_dir_all(&dir);
            return Err("HarnessDock 正在退出，已取消 Gateway 启动。".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let detail = public_gateway_diagnostic(&fs::read_to_string(&log_file).unwrap_or_default());
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err(format!("Gateway sidecar 在 ready 前退出: {status}\n{detail}"));
            }
            Ok(None) => {}
            Err(error) => {
                process_control::stop_child_tree(&mut child);
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err(format!("无法检查 Gateway sidecar 状态: {error}"));
            }
        }
        if let Ok(raw) = fs::read_to_string(&ready_file) {
            let ready: GatewayReady = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(error) => {
                    process_control::stop_child_tree(&mut child);
                    registration.complete();
                    let _ = fs::remove_dir_all(&dir);
                    return Err(format!("Gateway ready.json 无效: {error}"));
                }
            };
            if ready.schema_version != 1
                || ready.pid == 0
                || ready.pid != child.id()
                || ready.admin_token.len() < 32
                || ready.admin_token.len() > 512
            {
                process_control::stop_child_tree(&mut child);
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway ready.json 未通过安全校验。".into());
            }
            if !is_loopback_http_url(&ready.admin_url) {
                process_control::stop_child_tree(&mut child);
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway admin API 不是受管的 127.0.0.1 地址。".into());
            }
            if !is_loopback_http_url(&ready.local_url) {
                process_control::stop_child_tree(&mut child);
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway local URL 不是受管的 127.0.0.1 地址。".into());
            }
            if !is_public_gateway_url(&ready.public_url) {
                process_control::stop_child_tree(&mut child);
                registration.complete();
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway ready.json 的 public URL 未通过安全校验。".into());
            }
            return Ok(GatewayProcess {
                child,
                stopped: false,
                registration,
                work_dir: dir,
                ready,
            });
        }
        if deadline <= Instant::now() {
            process_control::stop_child_tree(&mut child);
            registration.complete();
            let detail = public_gateway_diagnostic(&fs::read_to_string(&log_file).unwrap_or_default());
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("等待 Gateway sidecar ready 超时。\n{detail}"));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn is_loopback_http_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|port| port > 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn is_public_gateway_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let loopback_http = url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"))
        && url.port().is_some_and(|port| port > 0);
    (url.scheme() == "https" || loopback_http)
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

async fn admin_json<T: DeserializeOwned>(
    ready: &GatewayReady,
    path: &str,
    body: Option<Value>,
) -> Result<T, String> {
    let base = reqwest::Url::parse(&ready.admin_url)
        .map_err(|error| format!("Gateway admin URL 无效: {error}"))?;
    let url = base
        .join(path)
        .map_err(|error| format!("Gateway admin path 无效: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;
    let request = match body {
        Some(value) => client.post(url).bearer_auth(&ready.admin_token).json(&value),
        None => client.get(url).bearer_auth(&ready.admin_token),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Gateway admin 请求失败: {error}"))?;
    let response = response
        .error_for_status()
        .map_err(|error| format!("Gateway admin 返回错误: {error}"))?;
    response
        .json::<T>()
        .await
        .map_err(|error| format!("Gateway admin JSON 无效: {error}"))
}

fn stopped() -> GatewayHostStatus {
    GatewayHostStatus {
        running: false,
        local_url: None,
        public_url: None,
        devices: Vec::new(),
    }
}

#[tauri::command]
pub async fn gateway_host_status(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    if crate::runtime::status_snapshot(&*state).app_url.is_none() {
        stop_managed(&state.gateway);
        return Ok(stopped());
    }
    let Some(ready) = gateway_ready_snapshot(&state)? else {
        return Ok(stopped());
    };
    match admin_json(&ready, "status", None).await {
        Ok(status) => Ok(status),
        Err(error) => {
            stop_managed_if_matches(&state.gateway, &ready);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn gateway_host_start(
    app: AppHandle,
    state: State<'_, AppState>,
    public_url: Option<String>,
    local_port: Option<u16>,
) -> Result<GatewayHostStatus, String> {
    if cfg!(mobile) {
        return Err("Android/iOS 只能作为 Gateway 客户端，不能托管桌面 Gateway。".into());
    }
    if state.quitting.load(std::sync::atomic::Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝新的 Gateway 启动。".into());
    }
    if state.runtime_restarting.load(Ordering::Acquire)
        || state.runtime_stopping.load(Ordering::Acquire)
    {
        return Err("Runtime 正在处理生命周期操作，暂时无法启动 Gateway。".into());
    }
    if crate::runtime::status_snapshot(&*state).app_url.is_none() {
        stop_managed(&state.gateway);
        return Err("请先启动本地 Runtime，再启动 Mobile Gateway。".into());
    }

    let port = validated_gateway_port(local_port)?;
    let public_url = validated_public_gateway_url(public_url)?;
    let _starting = claim_gateway_start(&state)?;
    let existing = begin_gateway_start(&state)?;
    if let Some(ready) = existing {
        drop(_starting);
        return match admin_json(&ready, "status", None).await {
            Ok(status) => Ok(status),
            Err(error) => {
                stop_managed_if_matches(&state.gateway, &ready);
                Err(error)
            }
        };
    }

    let (node, upstream_url) = runtime_gateway_inputs(&state)?;
    let sidecar = resource_path(&app, "gateway-sidecar.mjs")?;
    let starting_processes = std::sync::Arc::clone(&state.starting_processes);
    let quitting = Arc::clone(&state.quitting);
    let expected_upstream_url = upstream_url.clone();
    let process = tauri::async_runtime::spawn_blocking(move || {
        spawn_sidecar(node, sidecar, upstream_url, public_url, port, &starting_processes, &quitting)
    })
    .await
    .map_err(|error| format!("Gateway 启动任务失败: {error}"))??;
    let ready = process.ready.clone();
    let runtime_state = app.state::<AppState>();
    let runtime_status = crate::runtime::status_snapshot(&*runtime_state);
    if runtime_status.app_url.as_deref() != Some(expected_upstream_url.as_str()) {
        let mut process = process;
        process.stop();
        return Err("本地 Runtime 已在 Gateway 启动期间变化，Gateway 未继续运行。".into());
    }
    {
        let mut guard = state
            .gateway
            .lock()
            .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
        if state.quitting.load(Ordering::Acquire)
            || state.runtime_restarting.load(Ordering::Acquire)
            || state.runtime_stopping.load(Ordering::Acquire)
        {
            let mut process = process;
            process.stop();
            return Err(if state.quitting.load(Ordering::Acquire) {
                "HarnessDock 已进入退出流程，Gateway 未继续运行。".into()
            } else {
                "Runtime 已进入生命周期切换，Gateway 未继续运行。".into()
            });
        }
        *guard = Some(process);
        if let Some(process) = guard.as_ref() {
            process.registration.complete();
        }
    }
    let status = match admin_json(&ready, "status", None).await {
        Ok(status) => status,
        Err(error) => {
            if let Ok(mut guard) = state.gateway.lock() {
                if let Some(mut process) = guard.take() {
                    process.stop();
                }
            }
            return Err(error);
        }
    };
    drop(_starting);
    Ok(status)
}

#[tauri::command]
pub async fn gateway_host_create_pairing(
    state: State<'_, AppState>,
) -> Result<GatewayPairingTicket, String> {
    let ready = required_gateway_ready(&state)?;
    match admin_json(&ready, "pair", Some(json!({}))).await {
        Ok(ticket) => Ok(ticket),
        Err(error) => {
            stop_managed_if_matches(&state.gateway, &ready);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn gateway_host_revoke(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<bool, String> {
    let ready = required_gateway_ready(&state)?;
    match admin_json::<RevokeResponse>(&ready, "revoke", Some(json!({ "deviceId": device_id }))).await {
        Ok(response) => Ok(response.revoked),
        Err(error) => {
            stop_managed_if_matches(&state.gateway, &ready);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn gateway_host_revoke_all(state: State<'_, AppState>) -> Result<usize, String> {
    let ready = required_gateway_ready(&state)?;
    match admin_json::<RevokeAllResponse>(&ready, "revoke-all", Some(json!({}))).await {
        Ok(response) => Ok(response.revoked),
        Err(error) => {
            stop_managed_if_matches(&state.gateway, &ready);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn gateway_host_stop(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    if state.gateway_starting.load(Ordering::Acquire) {
        return Err("Gateway 正在启动，请稍候再停止。".into());
    }
    if let Some(mut process) = guard.take() {
        process.stop();
    }
    Ok(stopped())
}

pub(crate) fn stop_managed(gateway: &Mutex<Option<GatewayProcess>>) {
    if let Ok(mut guard) = gateway.lock() {
        if let Some(mut process) = guard.take() {
            process.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_public_url_is_https_or_explicit_local_debug_only() {
        assert!(validated_public_gateway_url(Some("https://gateway.example.com".into())).is_ok());
        assert!(validated_public_gateway_url(Some("http://127.0.0.1:43137/".into())).is_ok());
        assert!(validated_public_gateway_url(Some("http://localhost:43137/".into())).is_ok());
        assert!(validated_public_gateway_url(Some("http://gateway.example.com/".into())).is_err());
        assert!(validated_public_gateway_url(Some("https://user:pass@gateway.example.com/".into())).is_err());
        assert!(validated_public_gateway_url(Some("https://gateway.example.com/path".into())).is_err());
        assert!(validated_public_gateway_url(Some("https://gateway.example.com/?token=x".into())).is_err());
    }

    #[test]
    fn gateway_port_avoids_privileged_or_invalid_ports() {
        assert_eq!(validated_gateway_port(None).unwrap(), 43137);
        assert_eq!(validated_gateway_port(Some(1024)).unwrap(), 1024);
        assert!(validated_gateway_port(Some(0)).is_err());
        assert!(validated_gateway_port(Some(443)).is_err());
    }

    #[test]
    fn user_visible_gateway_diagnostic_redacts_urls_and_tokens() {
        let diagnostic = public_gateway_diagnostic(
            "starting gateway\nupstream https://example.test/?token=secret\nAuthorization: Bearer secret\nport already in use",
        );
        assert!(diagnostic.contains("starting gateway"));
        assert!(diagnostic.contains("port already in use"));
        assert!(!diagnostic.contains("example.test"));
        assert!(!diagnostic.contains("secret"));
        assert!(!diagnostic.to_ascii_lowercase().contains("bearer"));
    }

    #[cfg(unix)]
    #[test]
    fn gateway_work_dir_is_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = work_dir().unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let _ = fs::remove_dir_all(dir);
    }
}
