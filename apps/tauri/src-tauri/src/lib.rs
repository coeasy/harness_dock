use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use url::Url;
use uuid::Uuid;

#[derive(Default)]
struct ProcessState {
    runtime: Option<RuntimeProcess>,
    gateway: Option<GatewayProcess>,
}

#[derive(Default)]
struct HostState {
    processes: Mutex<ProcessState>,
}

struct RuntimeProcess {
    child: Child,
    app_url: String,
    dsh_version: String,
    work_dir: PathBuf,
}

struct GatewayProcess {
    child: Child,
    public_url: String,
    admin_url: String,
    admin_token: String,
    work_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: String,
    arch: String,
    mobile: bool,
    device_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: String,
    app_url: Option<String>,
    dsh_version: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLaunchResult {
    app_url: String,
    dsh_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyInfo {
    url: String,
    dsh_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginInfo {
    dsh_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayReadyInfo {
    public_url: String,
    admin_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayInfo {
    public_url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayPairingTicket {
    code: String,
    expires_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayDeviceInfo {
    id: String,
    name: String,
    paired_at: String,
    last_seen_at: String,
    session_expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRemoteResponse {
    connect_url: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRemoteResult {
    connect_url: String,
    expires_at: String,
}

fn mobile() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

fn err(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map_err(|e| err("resolve resource directory", e))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_cache_dir().map_err(|e| err("resolve app cache directory", e))?;
    fs::create_dir_all(&root).map_err(|e| err("create app cache directory", e))?;
    Ok(root)
}

fn runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let root = resource_dir(app)?;
    let runtime_root = root.join("dsh-runtime");
    let node = if cfg!(windows) { runtime_root.join("node.exe") } else { runtime_root.join("bin/node") };
    let dsh = runtime_root.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    Ok((node, dsh, root.join("embedded-client/index.js"), root.join("origin.json")))
}

fn origin(path: &Path) -> Result<OriginInfo, String> {
    let raw = fs::read_to_string(path).map_err(|e| err("read origin.json", e))?;
    serde_json::from_str(&raw).map_err(|e| err("parse origin.json", e))
}

fn configure_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn kill_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) { return; }
    let pid = child.id();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) { return; }
            thread::sleep(Duration::from_millis(100));
        }
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn write_patch(path: &Path, plugin: &Path) -> Result<(), String> {
    let plugin_url = Url::from_file_path(plugin)
        .map_err(|_| format!("cannot convert plugin path to file URL: {}", plugin.display()))?;
    let escaped = plugin_url.as_str().replace('\'', "''");
    fs::write(path, format!("- insert:\n    - id: embedded-client\n      name: '{escaped}'\n"))
        .map_err(|e| err("write runtime patch", e))
}

fn wait_ready(child: &mut Child, ready_file: &Path, timeout: Duration) -> Result<ReadyInfo, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("DeepSeek Harness exited before ready: {status}"));
        }
        if let Ok(raw) = fs::read_to_string(ready_file) {
            if let Ok(ready) = serde_json::from_str::<ReadyInfo>(&raw) {
                if ready.url.starts_with("http://127.0.0.1:") { return Ok(ready); }
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("DeepSeek Harness did not become ready within 120 seconds.".into())
}

fn start_runtime_blocking(app: &AppHandle, host: &HostState) -> Result<RuntimeLaunchResult, String> {
    if mobile() {
        return Err("Android/iOS use Remote Runtime; local dsh execution is disabled on mobile.".into());
    }
    let mut state = host.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    if let Some(runtime) = state.runtime.as_mut() {
        if matches!(runtime.child.try_wait(), Ok(None)) {
            return Ok(RuntimeLaunchResult { app_url: runtime.app_url.clone(), dsh_version: runtime.dsh_version.clone() });
        }
        if let Some(dead) = state.runtime.take() { let _ = fs::remove_dir_all(dead.work_dir); }
    }

    let (node, dsh, plugin, origin_path) = runtime_paths(app)?;
    for (name, path) in [("Node runtime", &node), ("dsh runtime", &dsh), ("embedded client", &plugin)] {
        if !path.is_file() { return Err(format!("{name} missing from Tauri Full bundle: {}", path.display())); }
    }
    let origin = origin(&origin_path)?;
    let work_dir = cache_dir(app)?.join(format!("runtime-{}", Uuid::new_v4()));
    fs::create_dir_all(&work_dir).map_err(|e| err("create runtime work directory", e))?;
    let patch = work_dir.join("embedded.patch.yml");
    let ready = work_dir.join("ready.json");
    let log_path = work_dir.join("runtime.log");
    write_patch(&patch, &plugin)?;
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| err("open runtime log", e))?;
    let log2 = log.try_clone().map_err(|e| err("clone runtime log", e))?;

    let mut command = Command::new(&node);
    command.arg(&dsh).args(["--profile", "web", "--patch"]).arg(&patch)
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("DSH_EMBEDDED_READY_FILE", &ready)
        .env("DSH_EMBEDDED_VERSION", &origin.dsh_version)
        .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
    configure_process(&mut command);
    let mut child = command.spawn().map_err(|e| err("spawn bundled dsh runtime", e))?;
    match wait_ready(&mut child, &ready, Duration::from_secs(120)) {
        Ok(info) => {
            let result = RuntimeLaunchResult { app_url: info.url.clone(), dsh_version: info.dsh_version.clone() };
            state.runtime = Some(RuntimeProcess { child, app_url: info.url, dsh_version: info.dsh_version, work_dir });
            Ok(result)
        }
        Err(e) => {
            kill_tree(&mut child);
            let _ = fs::remove_dir_all(&work_dir);
            Err(format!("{e} Runtime log: {}", log_path.display()))
        }
    }
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        mobile: mobile(),
        device_name: if mobile() { "HarnessDock Mobile" } else { "HarnessDock Desktop" }.into(),
    }
}

#[tauri::command]
fn runtime_status(state: State<'_, HostState>) -> Result<RuntimeStatus, String> {
    let mut processes = state.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    if let Some(runtime) = processes.runtime.as_mut() {
        match runtime.child.try_wait() {
            Ok(None) => return Ok(RuntimeStatus {
                state: "ready".into(), app_url: Some(runtime.app_url.clone()),
                dsh_version: Some(runtime.dsh_version.clone()), message: format!("Bundled dsh {} is running.", runtime.dsh_version),
            }),
            Ok(Some(status)) => {
                if let Some(dead) = processes.runtime.take() { let _ = fs::remove_dir_all(dead.work_dir); }
                return Ok(RuntimeStatus { state: "stopped".into(), app_url: None, dsh_version: None, message: format!("Runtime exited: {status}") });
            }
            Err(e) => return Err(err("inspect runtime process", e)),
        }
    }
    Ok(RuntimeStatus {
        state: if mobile() { "remote-only" } else { "stopped" }.into(), app_url: None, dsh_version: None,
        message: if mobile() { "Mobile builds connect to a paired Gateway." } else { "Bundled runtime has not started." }.into(),
    })
}

#[tauri::command]
async fn start_local_runtime(app: AppHandle) -> Result<RuntimeLaunchResult, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<HostState>();
        start_runtime_blocking(&worker, state.inner())
    }).await.map_err(|e| err("join runtime startup task", e))?
}

fn stop_gateway_locked(state: &mut ProcessState) {
    if let Some(mut gateway) = state.gateway.take() {
        kill_tree(&mut gateway.child);
        let _ = fs::remove_dir_all(gateway.work_dir);
    }
}

#[tauri::command]
fn stop_local_runtime(state: State<'_, HostState>) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    stop_gateway_locked(&mut processes);
    if let Some(mut runtime) = processes.runtime.take() {
        kill_tree(&mut runtime.child);
        let _ = fs::remove_dir_all(runtime.work_dir);
    }
    Ok(())
}

fn private_host(host: &str) -> bool {
    let value = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if value == "localhost" || value.ends_with(".local") { return true; }
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
        Err(_) => false,
    }
}

fn endpoint(raw: &str, allow_insecure: bool) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| err("parse Gateway URL", e))?;
    if !url.username().is_empty() || url.password().is_some() { return Err("Gateway URL must not contain credentials.".into()); }
    if url.path() != "/" && !url.path().is_empty() { return Err("Gateway URL must be an origin-root URL.".into()); }
    url.set_path("/"); url.set_query(None); url.set_fragment(None);
    match url.scheme() {
        "https" => Ok(url),
        "http" if allow_insecure && private_host(url.host_str().unwrap_or_default()) => Ok(url),
        "http" => Err("HTTP Gateway is allowed only for an explicitly approved private/loopback LAN address.".into()),
        other => Err(format!("Unsupported Gateway protocol: {other}")),
    }
}

fn wait_gateway(child: &mut Child, ready: &Path) -> Result<GatewayReadyInfo, String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() { return Err(format!("Gateway exited before ready: {status}")); }
        if let Ok(raw) = fs::read_to_string(ready) {
            if let Ok(info) = serde_json::from_str::<GatewayReadyInfo>(&raw) {
                if info.admin_url.starts_with("http://127.0.0.1:") { return Ok(info); }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Gateway did not become ready within 15 seconds.".into())
}

fn start_gateway_blocking(app: &AppHandle, host: &HostState, bind_host: String, port: u16, public_url: String, allow_insecure: bool) -> Result<GatewayInfo, String> {
    if mobile() { return Err("Gateway hosting is desktop-only.".into()); }
    let mut state = host.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    if let Some(gateway) = state.gateway.as_mut() {
        if matches!(gateway.child.try_wait(), Ok(None)) { return Ok(GatewayInfo { public_url: gateway.public_url.clone() }); }
        stop_gateway_locked(&mut state);
    }
    let upstream = state.runtime.as_ref().map(|v| v.app_url.clone()).ok_or_else(|| "Start local runtime before Gateway.".to_string())?;
    let public = if public_url.trim().is_empty() { String::new() } else { endpoint(&public_url, allow_insecure)?.to_string() };
    if !matches!(bind_host.trim(), "127.0.0.1" | "::1" | "localhost") && public.is_empty() {
        return Err("Non-loopback Gateway bind requires an explicit public URL.".into());
    }

    let root = resource_dir(app)?;
    let (node, _, _, _) = runtime_paths(app)?;
    let script = root.join("gateway-host.mjs");
    if !node.is_file() || !script.is_file() { return Err("Tauri Full bundle is missing Node runtime or gateway-host.mjs.".into()); }
    let work_dir = cache_dir(app)?.join(format!("gateway-{}", Uuid::new_v4()));
    fs::create_dir_all(&work_dir).map_err(|e| err("create Gateway work directory", e))?;
    let ready = work_dir.join("ready.json");
    let log_path = work_dir.join("gateway.log");
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| err("open Gateway log", e))?;
    let log2 = log.try_clone().map_err(|e| err("clone Gateway log", e))?;
    let mut command = Command::new(node);
    command.arg(script)
        .env("HARNESSDOCK_GATEWAY_UPSTREAM", upstream)
        .env("HARNESSDOCK_GATEWAY_BIND", bind_host.trim())
        .env("HARNESSDOCK_GATEWAY_PORT", port.to_string())
        .env("HARNESSDOCK_GATEWAY_PUBLIC_URL", public)
        .env("HARNESSDOCK_GATEWAY_ALLOW_INSECURE", if allow_insecure { "1" } else { "0" })
        .env("HARNESSDOCK_GATEWAY_ADMIN_TOKEN", &token)
        .env("HARNESSDOCK_GATEWAY_READY_FILE", &ready)
        .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
    configure_process(&mut command);
    let mut child = command.spawn().map_err(|e| err("spawn Gateway", e))?;
    match wait_gateway(&mut child, &ready) {
        Ok(info) => {
            let answer = GatewayInfo { public_url: info.public_url.clone() };
            state.gateway = Some(GatewayProcess { child, public_url: info.public_url, admin_url: info.admin_url, admin_token: token, work_dir });
            Ok(answer)
        }
        Err(e) => {
            kill_tree(&mut child); let _ = fs::remove_dir_all(&work_dir);
            Err(format!("{e} Gateway log: {}", log_path.display()))
        }
    }
}

#[tauri::command]
async fn start_gateway(app: AppHandle, bind_host: String, port: u16, public_url: String, allow_insecure: bool) -> Result<GatewayInfo, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<HostState>();
        start_gateway_blocking(&worker, state.inner(), bind_host, port, public_url, allow_insecure)
    }).await.map_err(|e| err("join Gateway startup task", e))?
}

#[tauri::command]
fn stop_gateway(state: State<'_, HostState>) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    stop_gateway_locked(&mut processes); Ok(())
}

fn admin(state: &State<'_, HostState>) -> Result<(String, String), String> {
    let processes = state.processes.lock().map_err(|_| "runtime state lock poisoned".to_string())?;
    let gateway = processes.gateway.as_ref().ok_or_else(|| "Gateway is not running.".to_string())?;
    Ok((gateway.admin_url.clone(), gateway.admin_token.clone()))
}

async fn admin_request<T: for<'de> Deserialize<'de>>(base: &str, token: &str, method: reqwest::Method, route: &str, body: Option<serde_json::Value>) -> Result<T, String> {
    let url = Url::parse(base).map_err(|e| err("parse admin URL", e))?.join(route).map_err(|e| err("resolve admin route", e))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|e| err("build admin client", e))?;
    let mut request = client.request(method, url).bearer_auth(token);
    if let Some(value) = body { request = request.json(&value); }
    let response = request.send().await.map_err(|e| err("call Gateway admin API", e))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("Gateway admin API {status}: {}", response.text().await.unwrap_or_default())); }
    response.json().await.map_err(|e| err("decode Gateway admin response", e))
}

#[tauri::command]
async fn gateway_create_pairing(state: State<'_, HostState>) -> Result<GatewayPairingTicket, String> {
    let (url, token) = admin(&state)?;
    admin_request(&url, &token, reqwest::Method::POST, "pairing", None).await
}

#[tauri::command]
async fn gateway_devices(state: State<'_, HostState>) -> Result<Vec<GatewayDeviceInfo>, String> {
    let (url, token) = admin(&state)?;
    admin_request(&url, &token, reqwest::Method::GET, "devices", None).await
}

#[tauri::command]
async fn gateway_revoke_device(state: State<'_, HostState>, device_id: String) -> Result<serde_json::Value, String> {
    let (url, token) = admin(&state)?;
    admin_request(&url, &token, reqwest::Method::POST, "revoke", Some(serde_json::json!({ "deviceId": device_id }))).await
}

#[tauri::command]
async fn pair_remote(endpoint_url: String, code: String, device_name: String, allow_insecure: bool) -> Result<PairRemoteResult, String> {
    let base = endpoint(&endpoint_url, allow_insecure)?;
    let pair_url = base.join("api/harnessdock/pair").map_err(|e| err("resolve pairing URL", e))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| err("build pairing client", e))?;
    let response = client.post(pair_url).json(&serde_json::json!({ "code": code, "deviceName": device_name })).send().await.map_err(|e| err("pair with Gateway", e))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("Pairing failed ({status}): {}", response.text().await.unwrap_or_default())); }
    let paired: PairRemoteResponse = response.json().await.map_err(|e| err("decode pairing response", e))?;
    let connect = Url::parse(&paired.connect_url).map_err(|e| err("parse connect URL", e))?;
    if connect.scheme() != base.scheme() || connect.host_str() != base.host_str() || connect.port_or_known_default() != base.port_or_known_default() {
        return Err("Gateway returned a connect URL on another origin.".into());
    }
    Ok(PairRemoteResult { connect_url: connect.to_string(), expires_at: paired.expires_at })
}

fn shutdown(host: &HostState) {
    if let Ok(mut state) = host.processes.lock() {
        stop_gateway_locked(&mut state);
        if let Some(mut runtime) = state.runtime.take() {
            kill_tree(&mut runtime.child); let _ = fs::remove_dir_all(runtime.work_dir);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HostState::default())
        .invoke_handler(tauri::generate_handler![
            platform_info, runtime_status, start_local_runtime, stop_local_runtime,
            start_gateway, stop_gateway, gateway_create_pairing, gateway_devices,
            gateway_revoke_device, pair_remote,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri application");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            let state = handle.state::<HostState>(); shutdown(state.inner());
        }
    });
}
