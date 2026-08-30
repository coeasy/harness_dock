use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use url::Url;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
};

#[derive(Default)]
struct RuntimeState {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct PlatformProfile {
    os: String,
    arch: String,
    mobile: bool,
}

#[derive(Serialize)]
struct ProbeResult {
    ok: bool,
    message: String,
}

#[derive(Serialize)]
struct RuntimeLaunch {
    pid: u32,
    web_url: String,
}

#[derive(Serialize)]
struct GatewaySession {
    web_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SavedConnection {
    gateway_url: String,
}

fn is_mobile() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

#[tauri::command]
fn platform_profile() -> PlatformProfile {
    PlatformProfile {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        mobile: is_mobile(),
    }
}

fn normalize_https_url(value: &str) -> Result<Url, String> {
    let parsed = Url::parse(value.trim()).map_err(|e| format!("invalid gateway URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or("gateway URL must include a host")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(
            "gateway must use HTTPS (HTTP is accepted only for loopback development)".into(),
        );
    }
    Ok(parsed)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connection.json"))
}

#[tauri::command]
fn load_connection(app: AppHandle) -> Result<SavedConnection, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(SavedConnection::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_connection(app: &AppHandle, gateway_url: &str) -> Result<(), String> {
    let path = config_path(app)?;
    let value = SavedConnection {
        gateway_url: gateway_url.to_string(),
    };
    let raw = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
async fn gateway_probe(url: String) -> Result<ProbeResult, String> {
    let base = normalize_https_url(&url)?;
    let endpoint = base
        .join("api/harnessdock/health")
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(endpoint).send().await {
        Ok(response) => Ok(ProbeResult {
            ok: response.status().is_success(),
            message: format!("HTTP {}", response.status()),
        }),
        Err(error) => Ok(ProbeResult {
            ok: false,
            message: error.to_string(),
        }),
    }
}

#[tauri::command]
async fn connect_gateway(
    app: AppHandle,
    gateway_url: String,
    credential: String,
) -> Result<GatewaySession, String> {
    let base = normalize_https_url(&gateway_url)?;
    if credential.trim().is_empty() {
        return Err("pairing code is required".into());
    }
    let endpoint = base
        .join("api/harnessdock/pair")
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(endpoint)
        .json(&serde_json::json!({
            "code": credential.trim(),
            "deviceName": format!("HarnessDock {}", std::env::consts::OS)
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("pairing failed: HTTP {}", response.status()));
    }
    let payload: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let connect_url = payload
        .get("connectUrl")
        .and_then(|v| v.as_str())
        .ok_or("gateway response did not include connectUrl")?;
    let parsed = normalize_https_url(connect_url)?;
    if parsed.origin() != base.origin() {
        return Err("gateway returned a cross-origin connect URL".into());
    }
    save_connection(&app, base.as_str())?;
    Ok(GatewaySession {
        web_url: parsed.to_string(),
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn runtime_layout(resource_dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = resource_dir.join("dsh-runtime");
    let node = if cfg!(windows) {
        root.join("node.exe")
    } else {
        root.join("bin").join("node")
    };
    let dsh = root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    let plugin = resource_dir.join("plugin-embedded-client").join("index.js");
    for required in [&node, &dsh, &plugin] {
        if !required.exists() {
            return Err(format!(
                "bundled runtime asset missing: {}",
                required.display()
            ));
        }
    }
    Ok((node, dsh, plugin))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_patch(app: &AppHandle, plugin: &Path) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("embedded-client.yml");
    let plugin_url =
        Url::from_file_path(plugin).map_err(|_| "failed to convert plugin path to file URL")?;
    let escaped = plugin_url.as_str().replace('\'', "''");
    fs::write(
        &path,
        format!("- insert:\n    - id: embedded-client\n      name: '{escaped}'\n"),
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn find_loopback_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let clean = token.trim_matches(|c: char| ")]}>'\"\u{1b},".contains(c));
        if clean.starts_with("http://127.0.0.1:") || clean.starts_with("https://127.0.0.1:") {
            let parsed = Url::parse(clean).ok()?;
            if parsed.host_str()? == "127.0.0.1" {
                return Some(clean.to_string());
            }
        }
    }
    None
}

#[tauri::command]
fn launch_local_runtime(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<RuntimeLaunch, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, state);
        Err("local DSH runtime is intentionally disabled on Android/iOS; connect through Gateway".into())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let mut guard = state.child.lock().map_err(|_| "runtime state poisoned")?;
        if let Some(existing) = guard.as_mut() {
            if existing.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Err("local runtime is already running; restart HarnessDock to create a new session URL".into());
            }
            *guard = None;
        }
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let (node, dsh, plugin) = runtime_layout(&resource_dir)?;
        let patch = write_patch(&app, &plugin)?;
        let mut child = Command::new(node)
            .arg(dsh)
            .args(["--profile", "web", "--patch"])
            .arg(patch)
            .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn bundled DSH runtime: {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("runtime stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("runtime stderr unavailable")?;
        let (tx, rx) = mpsc::channel::<String>();
        for reader in [BufReader::new(stdout), BufReader::new(stderr)] {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in reader.lines().map_while(Result::ok) {
                    if let Some(url) = find_loopback_url(&line) {
                        let _ = tx.send(url);
                        break;
                    }
                }
            });
        }
        drop(tx);
        *guard = Some(child);
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(web_url) => Ok(RuntimeLaunch { pid, web_url }),
            Err(_) => {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Err("DSH runtime started but did not publish a loopback Web URL within 30 seconds".into())
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            platform_profile,
            load_connection,
            gateway_probe,
            connect_gateway,
            launch_local_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running HarnessDock");
}
