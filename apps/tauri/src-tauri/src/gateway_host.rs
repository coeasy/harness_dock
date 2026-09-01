use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
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
    work_dir: PathBuf,
    ready: GatewayReady,
}

impl GatewayProcess {
    fn stop(&mut self) {
        process_control::stop_child_tree(&mut self.child);
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
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 Gateway 临时目录: {error}"))?;
    Ok(dir)
}

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|error| format!("无法解析 Gateway 资源 {relative}: {error}"))
}

fn gateway_ready_snapshot(state: &State<'_, AppState>) -> Result<Option<GatewayReady>, String> {
    let guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    Ok(guard.as_ref().map(|process| process.ready.clone()))
}

fn required_gateway_ready(state: &State<'_, AppState>) -> Result<GatewayReady, String> {
    gateway_ready_snapshot(state)?.ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())
}

fn runtime_gateway_inputs(state: &State<'_, AppState>) -> Result<(PathBuf, String), String> {
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "请先启动本地 Runtime，再启动 Mobile Gateway。".to_string())?;
    Ok(runtime.gateway_inputs())
}

fn spawn_sidecar(
    node: PathBuf,
    sidecar: PathBuf,
    upstream_url: String,
    public_url: Option<String>,
    local_port: u16,
    starting_processes: &process_control::StartingProcessRegistry,
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
    let stdout = fs::File::create(&log_file).map_err(|error| format!("无法创建 Gateway 日志: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("无法复制 Gateway 日志句柄: {error}"))?;
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
    if let Some(value) = public_url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        command.env("HARNESSDOCK_GATEWAY_PUBLIC_URL", value);
    }
    platform::configure_child_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Gateway sidecar: {error}"))?;
    let _registration = process_control::register_starting_process(starting_processes, child.id());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let detail = fs::read_to_string(&log_file).unwrap_or_default();
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("Gateway sidecar 在 ready 前退出: {status}\n{}", detail.trim()));
        }
        if let Ok(raw) = fs::read_to_string(&ready_file) {
            let ready: GatewayReady =
                serde_json::from_str(&raw).map_err(|error| format!("Gateway ready.json 无效: {error}"))?;
            if ready.schema_version != 1 || ready.pid == 0 || ready.admin_token.len() < 32 {
                process_control::stop_child_tree(&mut child);
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway ready.json 未通过安全校验。".into());
            }
            if !ready.admin_url.starts_with("http://127.0.0.1:") {
                process_control::stop_child_tree(&mut child);
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway admin API 不是 loopback 地址。".into());
            }
            if !ready.local_url.starts_with("http://127.0.0.1:") {
                process_control::stop_child_tree(&mut child);
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway local URL 不是 loopback 地址。".into());
            }
            if ready.public_url.trim().is_empty() {
                process_control::stop_child_tree(&mut child);
                let _ = fs::remove_dir_all(&dir);
                return Err("Gateway ready.json 缺少 public URL。".into());
            }
            return Ok(GatewayProcess {
                child,
                work_dir: dir,
                ready,
            });
        }
        if deadline <= Instant::now() {
            process_control::stop_child_tree(&mut child);
            let detail = fs::read_to_string(&log_file).unwrap_or_default();
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("等待 Gateway sidecar ready 超时。 {}", detail.trim()));
        }
        thread::sleep(Duration::from_millis(100));
    }
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
    let Some(ready) = gateway_ready_snapshot(&state)? else {
        return Ok(stopped());
    };
    admin_json(&ready, "status", None).await
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

    if let Some(ready) = gateway_ready_snapshot(&state)? {
        return admin_json(&ready, "status", None).await;
    }

    let (node, upstream_url) = runtime_gateway_inputs(&state)?;
    let port = local_port.unwrap_or(43137);
    if port == 0 {
        return Err("Gateway 本地端口不能为 0；远程 HTTPS tunnel 需要稳定的 loopback 端口。".into());
    }
    let sidecar = resource_path(&app, "gateway-sidecar.mjs")?;
    let starting_processes = std::sync::Arc::clone(&state.starting_processes);
    let process = tauri::async_runtime::spawn_blocking(move || {
        spawn_sidecar(node, sidecar, upstream_url, public_url, port, &starting_processes)
    })
    .await
    .map_err(|error| format!("Gateway 启动任务失败: {error}"))??;
    let ready = process.ready.clone();
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    if state.quitting.load(std::sync::atomic::Ordering::Acquire) {
        let mut process = process;
        process.stop();
        return Err("HarnessDock 已进入退出流程，Gateway 未继续运行。".into());
    }
    *guard = Some(process);
    admin_json(&ready, "status", None).await
}

#[tauri::command]
pub async fn gateway_host_create_pairing(
    state: State<'_, AppState>,
) -> Result<GatewayPairingTicket, String> {
    let ready = required_gateway_ready(&state)?;
    admin_json(&ready, "pair", Some(json!({}))).await
}

#[tauri::command]
pub async fn gateway_host_revoke(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<bool, String> {
    let ready = required_gateway_ready(&state)?;
    let response: RevokeResponse =
        admin_json(&ready, "revoke", Some(json!({ "deviceId": device_id }))).await?;
    Ok(response.revoked)
}

#[tauri::command]
pub async fn gateway_host_revoke_all(state: State<'_, AppState>) -> Result<usize, String> {
    let ready = required_gateway_ready(&state)?;
    let response: RevokeAllResponse =
        admin_json(&ready, "revoke-all", Some(json!({}))).await?;
    Ok(response.revoked)
}

#[tauri::command]
pub fn gateway_host_stop(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
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
