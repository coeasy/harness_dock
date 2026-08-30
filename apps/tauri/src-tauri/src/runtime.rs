use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use url::Url;

use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub app_url: Option<String>,
    pub dsh_version: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyInfo {
    url: String,
    host: String,
    port: u16,
    pid: u32,
    dsh_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginInfo {
    dsh_version: String,
}

pub(crate) struct RuntimeProcess {
    child: Child,
    work_dir: PathBuf,
    ready: ReadyInfo,
}

impl RuntimeProcess {
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: "ready".into(),
            app_url: Some(self.ready.url.clone()),
            dsh_version: Some(self.ready.dsh_version.clone()),
            pid: Some(self.ready.pid),
        }
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.work_dir);
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stopped() -> RuntimeStatus {
    RuntimeStatus { state: "stopped".into(), app_url: None, dsh_version: None, pid: None }
}

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|error| format!("无法解析应用资源 {relative}: {error}"))
}

fn node_path(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") { root.join("node.exe") } else { root.join("bin").join("node") }
}

fn dsh_path(root: &Path) -> PathBuf {
    root.join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js")
}

fn work_dir() -> Result<PathBuf, String> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    let dir = std::env::temp_dir().join(format!("harnessdock-tauri-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 Runtime 临时目录: {error}"))?;
    Ok(dir)
}

fn embedded_patch(plugin: &Path) -> Result<String, String> {
    let url = Url::from_file_path(plugin).map_err(|_| "无法把 embedded client 插件路径转换为 file URL。".to_string())?;
    let escaped = url.as_str().replace('\'', "''");
    Ok(format!("- insert:\n    - id: embedded-client\n      name: '{escaped}'\n"))
}

fn validated_ready(raw: &str, expected_version: &str) -> Result<ReadyInfo, String> {
    let ready: ReadyInfo = serde_json::from_str(raw).map_err(|error| format!("Runtime ready.json 无效: {error}"))?;
    if ready.dsh_version != expected_version {
        return Err(format!("Runtime 版本不一致: expected {expected_version}, got {}", ready.dsh_version));
    }
    if ready.host != "127.0.0.1" && ready.host != "::1" && ready.host != "localhost" {
        return Err(format!("Runtime 返回了非 loopback host: {}", ready.host));
    }
    if ready.port == 0 || ready.pid == 0 {
        return Err("Runtime ready.json 缺少有效端口或 PID。".into());
    }
    let app_url = Url::parse(&ready.url).map_err(|_| "Runtime 返回了无效 Web URL。".to_string())?;
    let host = app_url.host_str().ok_or_else(|| "Runtime Web URL 缺少主机名。".to_string())?;
    let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    if !loopback || (app_url.scheme() != "http" && app_url.scheme() != "https") {
        return Err("Runtime Web URL 必须使用 loopback HTTP(S)。".into());
    }
    Ok(ready)
}

fn start_blocking(runtime_root: PathBuf, plugin_path: PathBuf, origin_path: PathBuf) -> Result<RuntimeProcess, String> {
    let node = node_path(&runtime_root);
    let dsh = dsh_path(&runtime_root);
    if !node.is_file() || !dsh.is_file() {
        return Err(format!("Tauri Full Runtime 不完整: node={} dsh={}", node.display(), dsh.display()));
    }
    if !plugin_path.is_file() || !origin_path.is_file() {
        return Err("Tauri Runtime 缺少 origin.json 或 embedded-client 插件。".into());
    }
    let origin: OriginInfo = serde_json::from_str(&fs::read_to_string(&origin_path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("origin.json 无效: {error}"))?;
    let dir = work_dir()?;
    let patch_file = dir.join("embedded.patch.yml");
    let ready_file = dir.join("ready.json");
    fs::write(&patch_file, embedded_patch(&plugin_path)?).map_err(|error| format!("无法写入 embedded patch: {error}"))?;

    let mut child = Command::new(&node)
        .arg(&dsh)
        .args(["--profile", "web", "--patch"])
        .arg(&patch_file)
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("DSH_EMBEDDED_READY_FILE", &ready_file)
        .env("DSH_EMBEDDED_VERSION", &origin.dsh_version)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动本地 dsh Runtime: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("dsh Runtime 在 ready 前退出: {status}"));
        }
        if let Ok(raw) = fs::read_to_string(&ready_file) {
            match validated_ready(&raw, &origin.dsh_version) {
                Ok(ready) => {
                    thread::sleep(Duration::from_millis(750));
                    if child.try_wait().map_err(|error| error.to_string())?.is_none() {
                        return Ok(RuntimeProcess { child, work_dir: dir, ready });
                    }
                }
                Err(error) if deadline <= Instant::now() => {
                    let _ = child.kill();
                    let _ = fs::remove_dir_all(&dir);
                    return Err(error);
                }
                Err(_) => {}
            }
        }
        if deadline <= Instant::now() {
            let _ = child.kill();
            let _ = fs::remove_dir_all(&dir);
            return Err("等待 dsh Runtime ready 超时。".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    state.runtime.lock().ok().and_then(|guard| guard.as_ref().map(RuntimeProcess::status)).unwrap_or_else(stopped)
}

#[tauri::command]
pub async fn runtime_start(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    if cfg!(mobile) {
        return Err("Android/iOS 使用 Remote Gateway，不允许在移动设备内启动桌面 dsh Runtime。".into());
    }
    if let Some(current) = state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())?.as_ref() {
        return Ok(current.status());
    }
    let runtime_root = resource_path(&app, "dsh-runtime")?;
    let plugin_path = resource_path(&app, "plugin-embedded-client/index.js")?;
    let origin_path = resource_path(&app, "origin.json")?;
    let process = tauri::async_runtime::spawn_blocking(move || start_blocking(runtime_root, plugin_path, origin_path))
        .await
        .map_err(|error| format!("Runtime 启动任务失败: {error}"))??;
    let status = process.status();
    *state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())? = Some(process);
    Ok(status)
}

#[tauri::command]
pub fn runtime_stop(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let mut guard = state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
    if let Some(mut process) = guard.take() {
        process.stop();
    }
    Ok(stopped())
}

pub(crate) fn stop_managed(runtime: &Mutex<Option<RuntimeProcess>>) {
    if let Ok(mut guard) = runtime.lock() {
        if let Some(mut process) = guard.take() {
            process.stop();
        }
    }
}
