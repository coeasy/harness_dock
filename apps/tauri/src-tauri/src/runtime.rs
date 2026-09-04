use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use url::Url;

use crate::{
    platform, plugin_quarantine, process as process_control,
    runtime_actor::{
        CancellationToken, RuntimeActor, RuntimeGeneration, RuntimeLease, RuntimeMode, RuntimePhase,
    },
    startup_trace::{self, StartupPhase},
    AppState,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub app_url: Option<String>,
    pub dsh_version: Option<String>,
    pub pid: Option<u32>,
    pub generation: Option<u64>,
    pub image_identity: Option<String>,
    pub recovery_mode: bool,
    pub recovery_source: String,
    pub isolated_plugins: Vec<String>,
    pub suspected_plugins: Vec<String>,
    pub quarantine_expires_at: Option<u64>,
    pub safe_mode: bool,
    pub node_source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyInfo {
    url: String,
    host: String,
    port: u16,
    pid: u32,
    dsh_version: String,
    generation: u64,
    nonce: String,
    image_identity: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginInfo {
    dsh_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: Option<u32>,
    image_identity: Option<String>,
    image_identity_algorithm: Option<String>,
    runtime_embedded: Option<bool>,
    first_launch_runtime_download_required: Option<bool>,
    plugin_management_ready: Option<bool>,
    build_commit: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeImage {
    root: PathBuf,
    node: PathBuf,
    dsh: PathBuf,
    origin: OriginInfo,
    image_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigDumpRow {
    id: String,
    name: Option<String>,
    source: String,
}

#[derive(Debug)]
struct AttemptFailure {
    message: String,
    diagnostic: String,
}

pub(crate) struct RuntimeProcess {
    child: Child,
    stopped: bool,
    pub(crate) registration: process_control::StartingProcessGuard,
    work_dir: PathBuf,
    ready: ReadyInfo,
    recovery_source: String,
    isolated_plugins: Vec<String>,
    suspected_plugins: Vec<String>,
    quarantine_expires_at: Option<u64>,
    safe_mode: bool,
}

impl RuntimeProcess {
    fn status(&self, lease: Option<&RuntimeLease>) -> RuntimeStatus {
        RuntimeStatus {
            state: if self.safe_mode || !self.isolated_plugins.is_empty() {
                "degraded".into()
            } else {
                "ready".into()
            },
            app_url: Some(self.ready.url.clone()),
            dsh_version: Some(self.ready.dsh_version.clone()),
            pid: Some(self.ready.pid),
            generation: lease.map(|lease| lease.generation.id),
            image_identity: lease.map(|lease| lease.generation.image_identity.clone()),
            recovery_mode: self.safe_mode || !self.isolated_plugins.is_empty(),
            recovery_source: self.recovery_source.clone(),
            isolated_plugins: self.isolated_plugins.clone(),
            suspected_plugins: self.suspected_plugins.clone(),
            quarantine_expires_at: self.quarantine_expires_at,
            safe_mode: self.safe_mode,
            node_source: "bundled".into(),
        }
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.stopped = true;
                false
            }
            Ok(None) => true,
            Err(error) => {
                eprintln!(
                    "Unable to inspect dsh Runtime process; preserving current RuntimeLease until exit is confirmed: {error}"
                );
                true
            }
        }
    }

    pub(crate) fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            self.registration.terminate_tree();
            process_control::stop_child_tree(&mut self.child);
        }
        let _ = fs::remove_dir_all(&self.work_dir);
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn phase_status(phase: RuntimePhase, generation: Option<u64>) -> RuntimeStatus {
    RuntimeStatus {
        state: match phase {
            RuntimePhase::Stopped => "stopped",
            RuntimePhase::Preparing => "preparing",
            RuntimePhase::Starting => "starting",
            RuntimePhase::Probing => "probing",
            RuntimePhase::Ready => "ready",
            RuntimePhase::Degraded => "degraded",
            RuntimePhase::Stopping => "stopping",
            RuntimePhase::Cancelling => "cancelling",
            RuntimePhase::Failed => "failed",
        }
        .into(),
        app_url: None,
        dsh_version: None,
        pid: None,
        generation,
        image_identity: None,
        recovery_mode: false,
        recovery_source: "none".into(),
        isolated_plugins: Vec::new(),
        suspected_plugins: Vec::new(),
        quarantine_expires_at: None,
        safe_mode: false,
        node_source: "bundled".into(),
    }
}

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|error| format!("无法解析应用资源 {relative}: {error}"))
}

fn quarantine_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugin-quarantine.v1.json"))
        .map_err(|error| format!("无法解析插件隔离目录: {error}"))
}

fn node_path(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        root.join("node.exe")
    } else {
        root.join("bin").join("node")
    }
}

fn dsh_path(root: &Path) -> PathBuf {
    root.join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

fn verify_runtime_image(app: &AppHandle) -> Result<RuntimeImage, String> {
    let root = platform::node_cli_path(&resource_path(app, "dsh-runtime")?);
    let node = node_path(&root);
    let dsh = dsh_path(&root);
    let manifest_path = root.join("manifest.json");
    let origin_path = resource_path(app, "origin.json")?;

    if !node.is_file() || !dsh.is_file() || !manifest_path.is_file() || !origin_path.is_file() {
        return Err(format!(
            "Tauri Full Runtime 不完整: node={} dsh={} manifest={}",
            node.display(),
            dsh.display(),
            manifest_path.display()
        ));
    }
    let manifest: RuntimeManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("无法读取 Runtime manifest.json: {error}"))?,
    )
    .map_err(|error| format!("Runtime manifest.json 无效: {error}"))?;
    if manifest.schema_version != Some(1)
        || manifest.runtime_embedded != Some(true)
        || manifest.first_launch_runtime_download_required != Some(false)
    {
        return Err("Runtime manifest 未声明 sealed embedded/offline-first v1 contract。".into());
    }
    if manifest.plugin_management_ready == Some(false) {
        return Err("Runtime manifest 显示 pinned pnpm/plugin management 未准备完成。".into());
    }
    if manifest.image_identity_algorithm.as_deref() != Some("sha256-v1") {
        return Err("Runtime image identity algorithm 不是受支持的 sha256-v1。".into());
    }
    let image_identity = manifest
        .image_identity
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Runtime manifest 缺少 sealed imageIdentity。".to_string())?;
    if manifest
        .build_commit
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err("Runtime manifest buildCommit 为空。".into());
    }
    let origin: OriginInfo = serde_json::from_str(
        &fs::read_to_string(&origin_path)
            .map_err(|error| format!("无法读取 origin.json: {error}"))?,
    )
    .map_err(|error| format!("origin.json 无效: {error}"))?;

    startup_trace::mark(StartupPhase::RuntimeVerified);
    Ok(RuntimeImage {
        root,
        node,
        dsh,
        origin,
        image_identity,
    })
}

fn work_dir() -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("harnessdock-tauri-{}-{nonce}", std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&dir)
            .map_err(|error| format!("无法创建私有 Runtime 临时目录: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(&dir).map_err(|error| format!("无法创建 Runtime 临时目录: {error}"))?;
    }
    Ok(dir)
}

struct WorkDirGuard {
    path: PathBuf,
    retained: bool,
}

impl WorkDirGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            retained: false,
        }
    }

    fn retain(&mut self) {
        self.retained = true;
    }

    fn retain_result<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
        if result.is_ok() {
            self.retain();
        }
        result
    }
}

impl Drop for WorkDirGuard {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn embedded_patch(plugin: &Path, compatibility: &Path, shell: &Path) -> Result<String, String> {
    let plugin_url = Url::from_file_path(platform::node_cli_path(plugin))
        .map_err(|_| "无法把 embedded client 插件路径转换为 file URL。".to_string())?;
    let compatibility_url = Url::from_file_path(platform::node_cli_path(compatibility))
        .map_err(|_| "无法把客户端兼容层路径转换为 file URL。".to_string())?;
    let shell_url = Url::from_file_path(platform::node_cli_path(shell))
        .map_err(|_| "无法把 Harness Shell 插件路径转换为 file URL。".to_string())?;
    Ok(format!(
        "- insert:\n    - id: embedded-client\n      name: '{}'\n    - id: harnessdock-client-runtime-compat\n      name: '{}'\n    - id: harness-shell\n      name: '{}'\n",
        plugin_url.as_str().replace('\'', "''"),
        compatibility_url.as_str().replace('\'', "''"),
        shell_url.as_str().replace('\'', "''"),
    ))
}

fn decode_yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len().saturating_sub(1)].to_string());
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return value[1..value.len() - 1].replace("''", "'");
    }
    value.to_string()
}

fn parse_config_dump_rows(dump: &str) -> Vec<ConfigDumpRow> {
    let mut rows = Vec::new();
    let mut source = String::new();
    let mut current: Option<ConfigDumpRow> = None;
    for line in dump.lines() {
        if let Some(label) = line.strip_prefix("# == ") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            source = label
                .split(", patched by ")
                .next()
                .unwrap_or(label)
                .trim()
                .to_string();
            continue;
        }
        if let Some(raw_id) = line.strip_prefix("- id:") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            current = Some(ConfigDumpRow {
                id: decode_yaml_scalar(raw_id),
                name: None,
                source: source.clone(),
            });
            continue;
        }
        if let Some(row) = current.as_mut() {
            if let Some(raw_name) = line.strip_prefix("  name:") {
                row.name = Some(decode_yaml_scalar(raw_name));
            }
        }
    }
    if let Some(row) = current {
        rows.push(row);
    }
    rows
}

fn is_official_source(source: &str) -> bool {
    let normalized = source.replace('\\', "/");
    source.starts_with("@deepseek-ai/") || normalized.contains("/node_modules/@deepseek-ai/")
}

fn is_official_row(row: &ConfigDumpRow) -> bool {
    is_official_source(&row.source)
        || row.name.as_deref().is_some_and(|name| {
            name.starts_with("@deepseek-ai/") || name.contains("/node_modules/@deepseek-ai/")
        })
}

fn recovery_candidates(rows: &[ConfigDumpRow]) -> Vec<ConfigDumpRow> {
    rows.iter()
        .filter(|row| {
            !matches!(
                row.id.as_str(),
                "embedded-client" | "harnessdock-client-runtime-compat" | "harness-shell"
            ) && !row.source.is_empty()
                && !is_official_row(row)
        })
        .cloned()
        .collect()
}

fn basename(value: &str) -> &str {
    value.rsplit(['/', '\\']).next().unwrap_or(value)
}

fn diagnostic_matches(row: &ConfigDumpRow, diagnostic: &str) -> bool {
    let haystack = diagnostic.to_ascii_lowercase();
    let mut tokens = vec![row.id.as_str(), row.source.as_str(), basename(&row.source)];
    if let Some(name) = row.name.as_deref() {
        tokens.push(name);
        tokens.push(basename(name));
    }
    tokens
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value.len() >= 3)
        .any(|value| haystack.contains(&value))
}

fn recovery_plan(
    rows: &[ConfigDumpRow],
    diagnostic: &str,
) -> (Vec<ConfigDumpRow>, Vec<String>, String) {
    let candidates = recovery_candidates(rows);
    let suspected = candidates
        .iter()
        .filter(|row| diagnostic_matches(row, diagnostic))
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
    let reason = if suspected.is_empty() {
        "ambiguous"
    } else {
        "diagnostic-match"
    };
    (candidates, suspected, reason.to_string())
}

fn recovery_patch_ids(ids: &[String]) -> Result<String, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut output = String::new();
    for value in ids {
        if !seen.insert(value.clone()) {
            continue;
        }
        let id = serde_json::to_string(value).map_err(|error| error.to_string())?;
        output.push_str(&format!("- id: {id}\n  disabled: true\n"));
    }
    Ok(output)
}

fn recovery_patch(rows: &[ConfigDumpRow]) -> Result<String, String> {
    recovery_patch_ids(&rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>())
}

fn validated_ready(
    raw: &str,
    expected_version: &str,
    expected_pid: u32,
    expected_generation: &RuntimeGeneration,
) -> Result<ReadyInfo, String> {
    let ready: ReadyInfo =
        serde_json::from_str(raw).map_err(|error| format!("Runtime ready.json 无效: {error}"))?;
    if ready.dsh_version != expected_version {
        return Err(format!(
            "Runtime 版本不一致: expected {expected_version}, got {}",
            ready.dsh_version
        ));
    }
    if ready.generation != expected_generation.id
        || ready.nonce != expected_generation.nonce
        || ready.image_identity != expected_generation.image_identity
    {
        return Err(
            "Runtime ready.json generation/nonce/imageIdentity 未通过当前启动代际校验。".into(),
        );
    }
    if ready.host != "127.0.0.1" || ready.port == 0 || ready.pid != expected_pid || ready.pid == 0 {
        return Err("Runtime ready.json host/port/PID 未通过受管进程校验。".into());
    }
    let app_url = Url::parse(&ready.url).map_err(|_| "Runtime 返回了无效 Web URL。".to_string())?;
    if app_url.scheme() != "http"
        || app_url.host_str() != Some("127.0.0.1")
        || app_url.port() != Some(ready.port)
        || !app_url.username().is_empty()
        || app_url.password().is_some()
    {
        return Err("Runtime Web URL 必须精确匹配受管 http://127.0.0.1:<port> origin。".into());
    }
    Ok(ready)
}

fn read_attempt_logs(stdout_path: &Path, stderr_path: &Path) -> String {
    let combined = format!(
        "{}\n{}",
        fs::read_to_string(stdout_path).unwrap_or_default(),
        fs::read_to_string(stderr_path).unwrap_or_default()
    );
    if combined.chars().count() <= 32_000 {
        return combined;
    }
    combined
        .chars()
        .rev()
        .take(32_000)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn public_diagnostic(diagnostic: &str) -> String {
    let interesting = diagnostic
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.contains("http://")
                && !lower.contains("https://")
                && !lower.contains("token")
                && (lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("cannot")
                    || lower.contains("plugin")
                    || lower.contains("module"))
        })
        .take(24)
        .collect::<Vec<_>>();
    if interesting.is_empty() {
        "dsh startup failed; see application diagnostics for details".into()
    } else {
        interesting.join("\n")
    }
}

fn cancelled(token: &CancellationToken, quitting: &std::sync::atomic::AtomicBool) -> bool {
    token.is_cancelled() || quitting.load(Ordering::Acquire)
}

fn spawn_runtime(
    image: &RuntimeImage,
    patches: &[&Path],
    dsh_home: Option<&Path>,
    ready_file: &Path,
    dir: &Path,
    attempt: &str,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<
    (
        Child,
        PathBuf,
        PathBuf,
        process_control::StartingProcessGuard,
    ),
    String,
> {
    if cancelled(token, quitting) {
        return Err("Runtime generation was cancelled before spawn".into());
    }
    let stdout_path = dir.join(format!("{attempt}.stdout.log"));
    let stderr_path = dir.join(format!("{attempt}.stderr.log"));
    let stdout = fs::File::create(&stdout_path)
        .map_err(|error| format!("无法创建 Runtime stdout 日志: {error}"))?;
    let stderr = fs::File::create(&stderr_path)
        .map_err(|error| format!("无法创建 Runtime stderr 日志: {error}"))?;
    let mut command = Command::new(platform::node_cli_path(&image.node));
    command
        .arg(platform::node_cli_path(&image.dsh))
        .args(["--profile", "web"]);
    for patch in patches {
        command.arg("--patch").arg(platform::node_cli_path(patch));
    }
    command
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env(
            "DSH_EMBEDDED_READY_FILE",
            platform::node_cli_path(ready_file),
        )
        .env("DSH_EMBEDDED_VERSION", &image.origin.dsh_version)
        .env("HARNESSDOCK_RUNTIME_GENERATION", generation.id.to_string())
        .env("HARNESSDOCK_RUNTIME_NONCE", &generation.nonce)
        .env(
            "HARNESSDOCK_RUNTIME_IMAGE_IDENTITY",
            &generation.image_identity,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(home) = dsh_home {
        command.env("DSH_HOME", platform::node_cli_path(home));
    }
    platform::configure_child_command(&mut command);
    let result = process_control::spawn_registered(&mut command, starting_processes, quitting)?;
    startup_trace::mark(StartupPhase::RuntimeSpawned);
    Ok((result.0, stdout_path, stderr_path, result.1))
}

fn wait_for_ready(
    child: &mut Child,
    ready_file: &Path,
    expected_version: &str,
    expected_pid: u32,
    expected_generation: &RuntimeGeneration,
    stdout_path: &Path,
    stderr_path: &Path,
    token: &CancellationToken,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<ReadyInfo, AttemptFailure> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if cancelled(token, quitting) {
            process_control::stop_child_tree(child);
            return Err(AttemptFailure {
                message: "Runtime generation cancelled while waiting for ready".into(),
                diagnostic: read_attempt_logs(stdout_path, stderr_path),
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(AttemptFailure {
                    message: format!("dsh Runtime 在 ready 前退出: {status}"),
                    diagnostic: read_attempt_logs(stdout_path, stderr_path),
                })
            }
            Ok(None) => {}
            Err(error) => {
                return Err(AttemptFailure {
                    message: format!("无法检查 dsh Runtime 状态: {error}"),
                    diagnostic: read_attempt_logs(stdout_path, stderr_path),
                })
            }
        }
        if let Ok(raw) = fs::read_to_string(ready_file) {
            match validated_ready(&raw, expected_version, expected_pid, expected_generation) {
                Ok(ready) => {
                    thread::sleep(Duration::from_millis(500));
                    if cancelled(token, quitting) {
                        process_control::stop_child_tree(child);
                        return Err(AttemptFailure {
                            message: "Runtime generation cancelled during stability probe".into(),
                            diagnostic: read_attempt_logs(stdout_path, stderr_path),
                        });
                    }
                    return match child.try_wait() {
                        Ok(None) => Ok(ready),
                        Ok(Some(status)) => Err(AttemptFailure {
                            message: format!("dsh Runtime 在稳定窗口内退出: {status}"),
                            diagnostic: read_attempt_logs(stdout_path, stderr_path),
                        }),
                        Err(error) => Err(AttemptFailure {
                            message: error.to_string(),
                            diagnostic: read_attempt_logs(stdout_path, stderr_path),
                        }),
                    };
                }
                Err(error) if deadline <= Instant::now() => {
                    process_control::stop_child_tree(child);
                    return Err(AttemptFailure {
                        message: error,
                        diagnostic: read_attempt_logs(stdout_path, stderr_path),
                    });
                }
                Err(_) => {}
            }
        }
        if deadline <= Instant::now() {
            process_control::stop_child_tree(child);
            return Err(AttemptFailure {
                message: "等待 dsh Runtime ready 超时。".into(),
                diagnostic: read_attempt_logs(stdout_path, stderr_path),
            });
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn dump_config(
    image: &RuntimeImage,
    embedded_patch_file: &Path,
    default_only: bool,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<String, String> {
    if cancelled(token, quitting) {
        return Err("Runtime generation cancelled before config dump".into());
    }
    let mut command = Command::new(platform::node_cli_path(&image.node));
    command
        .arg(platform::node_cli_path(&image.dsh))
        .args(["--profile", "web"]);
    if default_only {
        command.arg("--dump-default-config");
    } else {
        command
            .args(["--patch"])
            .arg(platform::node_cli_path(embedded_patch_file))
            .arg("--dump-config");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::configure_child_command(&mut command);
    let (mut child, registration) =
        process_control::spawn_registered(&mut command, starting_processes, quitting)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if cancelled(token, quitting) {
            registration.terminate_tree();
            process_control::stop_child_tree(&mut child);
            registration.complete();
            return Err("Runtime generation cancelled during config dump".into());
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = match child.wait_with_output() {
                    Ok(output) => output,
                    Err(error) => {
                        registration.complete();
                        return Err(error.to_string());
                    }
                };
                registration.complete();
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(2_000)
                        .collect());
                }
                return String::from_utf8(output.stdout)
                    .map_err(|error| format!("dsh config dump 输出不是 UTF-8: {error}"));
            }
            Ok(None) => {}
            Err(error) => {
                registration.terminate_tree();
                process_control::stop_child_tree(&mut child);
                registration.complete();
                return Err(error.to_string());
            }
        }
        if deadline <= Instant::now() {
            registration.terminate_tree();
            process_control::stop_child_tree(&mut child);
            registration.complete();
            return Err("等待 dsh config dump 超时。".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn dsh_home_path() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".dsh"))
        })
}

fn user_patch_rows() -> Vec<ConfigDumpRow> {
    let Some(home) = dsh_home_path() else {
        return Vec::new();
    };
    let paths = [
        home.join("profiles").join("web").join("cordis.patch.yml"),
        home.join("cordis.patch.yml"),
    ];
    let mut rows = Vec::new();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let source = path.to_string_lossy().into_owned();
        let mut current: Option<ConfigDumpRow> = None;
        for line in raw.lines().map(str::trim_start) {
            if let Some(raw_id) = line.strip_prefix("- id:") {
                if let Some(row) = current.take() {
                    rows.push(row);
                }
                current = Some(ConfigDumpRow {
                    id: decode_yaml_scalar(raw_id),
                    name: None,
                    source: source.clone(),
                });
            } else if let Some(row) = current.as_mut() {
                if let Some(raw_name) = line.strip_prefix("name:") {
                    row.name = Some(decode_yaml_scalar(raw_name));
                }
            }
        }
        if let Some(row) = current {
            rows.push(row);
        }
    }
    rows
}

fn recovery_rows(
    image: &RuntimeImage,
    embedded_patch_file: &Path,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<Vec<ConfigDumpRow>, String> {
    match dump_config(
        image,
        embedded_patch_file,
        false,
        token,
        starting_processes,
        quitting,
    ) {
        Ok(config) => Ok(parse_config_dump_rows(&config)),
        Err(full_error) => {
            let default = dump_config(
                image,
                embedded_patch_file,
                true,
                token,
                starting_processes,
                quitting,
            )
            .map_err(|default_error| {
                format!("{full_error}; 默认配置转储也失败: {default_error}")
            })?;
            let mut rows = parse_config_dump_rows(&default);
            rows.extend(user_patch_rows());
            Ok(rows)
        }
    }
}

fn launch_attempt(
    image: &RuntimeImage,
    patches: &[&Path],
    dsh_home: Option<&Path>,
    ready_file: &Path,
    dir: &Path,
    attempt: &str,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<RuntimeProcess, AttemptFailure> {
    let (mut child, stdout, stderr, registration) = spawn_runtime(
        image,
        patches,
        dsh_home,
        ready_file,
        dir,
        attempt,
        generation,
        token,
        starting_processes,
        quitting,
    )
    .map_err(|message| AttemptFailure {
        message,
        diagnostic: String::new(),
    })?;
    let pid = child.id();
    let ready = match wait_for_ready(
        &mut child,
        ready_file,
        &image.origin.dsh_version,
        pid,
        generation,
        &stdout,
        &stderr,
        token,
        quitting,
    ) {
        Ok(ready) => ready,
        Err(error) => {
            registration.terminate_tree();
            process_control::stop_child_tree(&mut child);
            registration.complete();
            return Err(error);
        }
    };
    Ok(RuntimeProcess {
        child,
        stopped: false,
        registration,
        work_dir: dir.to_path_buf(),
        ready,
        recovery_source: "none".into(),
        isolated_plugins: Vec::new(),
        suspected_plugins: Vec::new(),
        quarantine_expires_at: None,
        safe_mode: false,
    })
}

fn safe_profile(
    image: &RuntimeImage,
    embedded_patch_file: &Path,
    ready_file: &Path,
    dir: &Path,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<RuntimeProcess, String> {
    let safe_home = dir.join("safe-dsh-home");
    fs::create_dir_all(&safe_home).map_err(|error| format!("无法创建安全 DSH_HOME: {error}"))?;
    let _ = fs::remove_file(ready_file);
    let mut process = launch_attempt(
        image,
        &[embedded_patch_file],
        Some(&safe_home),
        ready_file,
        dir,
        "safe",
        generation,
        token,
        starting_processes,
        quitting,
    )
    .map_err(|error| {
        format!(
            "安全配置启动失败: {}\n{}",
            error.message,
            public_diagnostic(&error.diagnostic)
        )
    })?;
    process.safe_mode = true;
    process.recovery_source = "safe-profile".into();
    Ok(process)
}

fn start_blocking(
    image: RuntimeImage,
    plugin_path: PathBuf,
    compatibility_path: PathBuf,
    shell_plugin_path: PathBuf,
    quarantine_state_path: PathBuf,
    generation: RuntimeGeneration,
    token: CancellationToken,
    force_safe_mode: bool,
    starting_processes: process_control::StartingProcessRegistry,
    quitting: Arc<std::sync::atomic::AtomicBool>,
) -> Result<RuntimeProcess, String> {
    let dir = work_dir()?;
    let mut work_dir_guard = WorkDirGuard::new(dir.clone());
    let patch_file = dir.join("embedded.patch.yml");
    let ready_file = dir.join("ready.json");
    let patch = embedded_patch(&plugin_path, &compatibility_path, &shell_plugin_path)?;
    fs::write(&patch_file, patch).map_err(|error| format!("无法写入 embedded patch: {error}"))?;
    if cancelled(&token, &quitting) {
        return Err("Runtime generation cancelled before startup".into());
    }

    if force_safe_mode {
        return work_dir_guard.retain_result(safe_profile(
            &image,
            &patch_file,
            &ready_file,
            &dir,
            &generation,
            &token,
            &starting_processes,
            &quitting,
        ));
    }

    let recovery_enabled =
        std::env::var("HARNESSDOCK_PLUGIN_RECOVERY").ok().as_deref() != Some("0");
    if recovery_enabled {
        if let Some(quarantine) =
            plugin_quarantine::read(&quarantine_state_path, &image.origin.dsh_version)
        {
            let quarantine_file = dir.join("plugin-quarantine.patch.yml");
            fs::write(
                &quarantine_file,
                recovery_patch_ids(&quarantine.isolated_plugins)?,
            )
            .map_err(|error| format!("无法写入插件隔离 patch: {error}"))?;
            let _ = fs::remove_file(&ready_file);
            if let Ok(mut process) = launch_attempt(
                &image,
                &[patch_file.as_path(), quarantine_file.as_path()],
                None,
                &ready_file,
                &dir,
                "quarantine",
                &generation,
                &token,
                &starting_processes,
                &quitting,
            ) {
                process.recovery_source = "quarantine".into();
                process.isolated_plugins = quarantine.isolated_plugins;
                process.suspected_plugins = quarantine.suspected_plugins;
                process.quarantine_expires_at = Some(quarantine.expires_at);
                work_dir_guard.retain();
                return Ok(process);
            }
            let _ = plugin_quarantine::clear(&quarantine_state_path);
        }
    }

    let _ = fs::remove_file(&ready_file);
    match launch_attempt(
        &image,
        &[patch_file.as_path()],
        None,
        &ready_file,
        &dir,
        "normal",
        &generation,
        &token,
        &starting_processes,
        &quitting,
    ) {
        Ok(process) => {
            work_dir_guard.retain();
            return Ok(process);
        }
        Err(first_failure) => {
            if cancelled(&token, &quitting) {
                return Err("Runtime generation cancelled during startup".into());
            }
            if !recovery_enabled {
                let summary = public_diagnostic(&first_failure.diagnostic);
                return Err(format!("{}\n{}", first_failure.message, summary));
            }
            let rows =
                match recovery_rows(&image, &patch_file, &token, &starting_processes, &quitting) {
                    Ok(rows) => rows,
                    Err(error) => {
                        eprintln!(
                            "Plugin recovery config discovery failed; using safe profile: {error}"
                        );
                        return work_dir_guard.retain_result(safe_profile(
                            &image,
                            &patch_file,
                            &ready_file,
                            &dir,
                            &generation,
                            &token,
                            &starting_processes,
                            &quitting,
                        ));
                    }
                };
            let (selected, suspected, reason) = recovery_plan(&rows, &first_failure.diagnostic);
            if selected.is_empty() {
                return work_dir_guard.retain_result(safe_profile(
                    &image,
                    &patch_file,
                    &ready_file,
                    &dir,
                    &generation,
                    &token,
                    &starting_processes,
                    &quitting,
                ));
            }
            let recovery_file = dir.join("plugin-recovery.patch.yml");
            fs::write(&recovery_file, recovery_patch(&selected)?)
                .map_err(|error| format!("无法写入插件兼容恢复 patch: {error}"))?;
            let isolated = selected
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>();
            let _ = fs::remove_file(&ready_file);
            match launch_attempt(
                &image,
                &[patch_file.as_path(), recovery_file.as_path()],
                None,
                &ready_file,
                &dir,
                "recovery",
                &generation,
                &token,
                &starting_processes,
                &quitting,
            ) {
                Ok(mut process) => {
                    let quarantine = plugin_quarantine::write(
                        &quarantine_state_path,
                        &image.origin.dsh_version,
                        isolated.clone(),
                        suspected.clone(),
                        &reason,
                    )
                    .ok();
                    process.recovery_source = "startup-failure".into();
                    process.isolated_plugins = isolated;
                    process.suspected_plugins = suspected;
                    process.quarantine_expires_at = quarantine.map(|value| value.expires_at);
                    work_dir_guard.retain();
                    Ok(process)
                }
                Err(recovery_failure) => {
                    eprintln!(
                        "Plugin quarantine attempt failed: {} / {}",
                        first_failure.message, recovery_failure.message
                    );
                    work_dir_guard.retain_result(safe_profile(
                        &image,
                        &patch_file,
                        &ready_file,
                        &dir,
                        &generation,
                        &token,
                        &starting_processes,
                        &quitting,
                    ))
                }
            }
        }
    }
}

fn lease_from_process(
    generation: RuntimeGeneration,
    process: &RuntimeProcess,
) -> Result<RuntimeLease, String> {
    let url =
        Url::parse(&process.ready.url).map_err(|_| "Runtime ready URL invalid".to_string())?;
    Ok(RuntimeLease {
        generation,
        pid: process.ready.pid,
        origin: url.origin().ascii_serialization(),
        launch_url: process.ready.url.clone(),
        dsh_version: process.ready.dsh_version.clone(),
    })
}

pub(crate) fn current_lease(state: &AppState) -> Option<RuntimeLease> {
    match state.runtime_actor.lock() {
        Ok(actor) => actor.lease(),
        Err(poisoned) => poisoned.into_inner().lease(),
    }
}

pub(crate) fn live_lease(state: &AppState) -> Option<RuntimeLease> {
    let _ = status_snapshot(state);
    current_lease(state)
}

fn mark_start_failed(state: &AppState, generation: u64, error: String) -> String {
    match state.runtime_actor.lock() {
        Ok(mut actor) => actor.mark_failed(generation, error.clone()),
        Err(poisoned) => poisoned.into_inner().mark_failed(generation, error.clone()),
    }
    error
}

pub(crate) fn status_snapshot(state: &AppState) -> RuntimeStatus {
    let mut actor = match state.runtime_actor.lock() {
        Ok(actor) => actor,
        Err(poisoned) => poisoned.into_inner(),
    };
    let dead = actor
        .process_mut()
        .is_some_and(|process| !process.is_alive());
    if dead {
        let process = actor.invalidate_dead_process();
        drop(actor);
        if let Some(mut process) = process {
            process.stop();
        }
        crate::gateway_host::stop_managed(&state.gateway);
        return phase_status(RuntimePhase::Stopped, None);
    }
    let lease = actor.lease();
    if let Some(process) = actor.process() {
        return process.status(lease.as_ref());
    }
    phase_status(actor.phase(), actor.generation_id())
}

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    status_snapshot(&*state)
}

async fn start_impl(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: RuntimeMode,
) -> Result<RuntimeStatus, String> {
    if cfg!(mobile) {
        return Err("Android/iOS 使用 Remote Gateway，不允许启动桌面 dsh Runtime。".into());
    }
    if state.quitting.load(Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝新的 Runtime 启动。".into());
    }

    let existing = status_snapshot(&*state);
    if existing.app_url.is_some() {
        return Ok(existing);
    }

    let (generation, token) = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| "RuntimeActor 状态锁已损坏。".to_string())?;
        actor.begin_start(mode)?
    };
    let image = match verify_runtime_image(&app) {
        Ok(image) => image,
        Err(error) => {
            return Err(mark_start_failed(&*state, generation.id, error));
        }
    };
    let generation = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| "RuntimeActor 状态锁已损坏。".to_string())?;
        let generation = match actor.bind_image(generation.id, image.image_identity.clone()) {
            Ok(generation) => generation,
            Err(error) => {
                actor.mark_failed(generation.id, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = actor.mark_starting(generation.id) {
            actor.mark_failed(generation.id, error.clone());
            return Err(error);
        }
        if let Err(error) = actor.mark_probing(generation.id) {
            actor.mark_failed(generation.id, error.clone());
            return Err(error);
        }
        generation
    };

    let plugin_path = match resource_path(&app, "plugin-embedded-client/index.js") {
        Ok(path) => path,
        Err(error) => return Err(mark_start_failed(&*state, generation.id, error)),
    };
    let compatibility_path = match resource_path(&app, "dsh-client-runtime-compat/index.js") {
        Ok(path) => path,
        Err(error) => return Err(mark_start_failed(&*state, generation.id, error)),
    };
    let shell_plugin_path = match resource_path(&app, "plugin-harness-shell/index.js") {
        Ok(path) => path,
        Err(error) => return Err(mark_start_failed(&*state, generation.id, error)),
    };
    let quarantine_state_path = match quarantine_path(&app) {
        Ok(path) => path,
        Err(error) => return Err(mark_start_failed(&*state, generation.id, error)),
    };
    for required in [&plugin_path, &compatibility_path, &shell_plugin_path] {
        if !required.is_file() {
            let error = format!(
                "Tauri Runtime integration resource missing: {}",
                required.display()
            );
            return Err(mark_start_failed(&*state, generation.id, error));
        }
    }
    let starting_processes = Arc::clone(&state.starting_processes);
    let quitting = Arc::clone(&state.quitting);
    let force_safe_mode = mode == RuntimeMode::Safe;
    let spawn_generation = generation.clone();
    let spawn_token = token.clone();
    let process = match tauri::async_runtime::spawn_blocking(move || {
        start_blocking(
            image,
            plugin_path,
            compatibility_path,
            shell_plugin_path,
            quarantine_state_path,
            spawn_generation,
            spawn_token,
            force_safe_mode,
            starting_processes,
            quitting,
        )
    })
    .await
    {
        Ok(process) => process,
        Err(error) => {
            return Err(mark_start_failed(
                &*state,
                generation.id,
                format!("Runtime 启动任务失败: {error}"),
            ));
        }
    };

    let mut process = match process {
        Ok(process) => process,
        Err(error) => {
            return Err(mark_start_failed(&*state, generation.id, error));
        }
    };
    if state.quitting.load(Ordering::Acquire) || token.is_cancelled() {
        process.stop();
        match state.runtime_actor.lock() {
            Ok(mut actor) => {
                if actor.generation_id() == Some(generation.id) {
                    actor.settle_stopped();
                }
            }
            Err(poisoned) => {
                let mut actor = poisoned.into_inner();
                if actor.generation_id() == Some(generation.id) {
                    actor.settle_stopped();
                }
            }
        }
        return Err("Runtime generation was cancelled before publication".into());
    }
    let lease = match lease_from_process(generation.clone(), &process) {
        Ok(lease) => lease,
        Err(error) => {
            process.stop();
            return Err(mark_start_failed(&*state, generation.id, error));
        }
    };
    let degraded = process.safe_mode || !process.isolated_plugins.is_empty();
    {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| "RuntimeActor 状态锁已损坏。".to_string())?;
        if let Err(mut stale) = actor.publish_ready(generation.id, process, lease, degraded) {
            stale.stop();
            return Err("陈旧 Runtime generation 已被丢弃。".into());
        }
        if let Some(process) = actor.process() {
            process.registration.complete();
        }
    }
    startup_trace::mark(StartupPhase::RuntimeReady);
    Ok(status_snapshot(&*state))
}

#[tauri::command]
pub async fn runtime_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    start_impl(app, state, RuntimeMode::Normal).await
}

pub(crate) async fn start_for_boot(app: AppHandle) -> Result<RuntimeStatus, String> {
    let state = app.state::<AppState>();
    start_impl(app.clone(), state, RuntimeMode::Normal).await
}

fn stop_impl(state: &AppState) -> Result<RuntimeStatus, String> {
    crate::gateway_host::stop_managed(&state.gateway);
    let process = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| "RuntimeActor 状态锁已损坏。".to_string())?;
        actor.begin_stop()
    };
    process_control::stop_starting_processes(&state.starting_processes);
    if let Some(mut process) = process {
        process.stop();
    }
    {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| "RuntimeActor 状态锁已损坏。".to_string())?;
        actor.settle_stopped();
    }
    // Gateway start publishes outside the RuntimeActor lock. A stop can
    // therefore pass its first Gateway sweep while a late start is still
    // publishing; sweep again after Runtime has settled to close that race.
    crate::gateway_host::stop_managed(&state.gateway);
    Ok(phase_status(RuntimePhase::Stopped, None))
}

#[tauri::command]
pub fn runtime_stop(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    stop_impl(&*state)
}

pub(crate) async fn restart_managed(app: AppHandle) -> Result<RuntimeStatus, String> {
    restart_managed_mode(app, RuntimeMode::Normal).await
}

pub(crate) async fn restart_managed_safe(app: AppHandle) -> Result<RuntimeStatus, String> {
    restart_managed_mode(app, RuntimeMode::Safe).await
}

async fn restart_managed_mode(app: AppHandle, mode: RuntimeMode) -> Result<RuntimeStatus, String> {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝 Runtime 重启。".into());
    }
    stop_impl(&*state)?;
    let state = app.state::<AppState>();
    start_impl(app.clone(), state, mode).await
}

#[tauri::command]
pub fn runtime_clear_plugin_quarantine(app: AppHandle) -> Result<(), String> {
    plugin_quarantine::clear(&quarantine_path(&app)?)
}

pub(crate) fn stop_managed(runtime: &Mutex<RuntimeActor>) {
    let process = match runtime.lock() {
        Ok(mut actor) => actor.begin_stop(),
        Err(poisoned) => poisoned.into_inner().begin_stop(),
    };
    if let Some(mut process) = process {
        process.stop();
    }
    match runtime.lock() {
        Ok(mut actor) => actor.settle_stopped(),
        Err(poisoned) => poisoned.into_inner().settle_stopped(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "# == @deepseek-ai/dsh-bundle-base\n- id: official-core\n  name: '@deepseek-ai/plugin-core'\n# == third-party-bundle\n- id: old-market-plugin\n  name: '@legacy/old-market-plugin'\n# == /home/me/.dsh/cordis.patch.yml\n- id: user-added\n  name: 'file:///home/me/plugin.js'\n# == /tmp/embedded.patch.yml\n- id: embedded-client\n  name: 'file:///tmp/embedded.js'\n- id: harnessdock-client-runtime-compat\n  name: 'file:///tmp/compat.js'\n- id: harness-shell\n  name: 'file:///tmp/shell.js'\n";

    fn generation() -> RuntimeGeneration {
        RuntimeGeneration {
            id: 7,
            nonce: "nonce-7".into(),
            image_identity: "sha256:image-7".into(),
            mode: RuntimeMode::Normal,
        }
    }

    #[test]
    fn recovery_never_targets_official_or_embedded_rows() {
        let rows = parse_config_dump_rows(DUMP);
        let candidates = recovery_candidates(&rows);
        assert_eq!(
            candidates
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["old-market-plugin", "user-added"]
        );
    }

    #[test]
    fn ready_file_must_belong_to_spawned_process_managed_origin_and_generation() {
        let expected = generation();
        let raw = r#"{"url":"http://127.0.0.1:43123/?token=launch","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        assert!(validated_ready(raw, "0.1.2-alpha.1", 41, &expected).is_err());
        assert!(validated_ready(raw, "0.1.2-alpha.1", 42, &expected).is_ok());
        let wrong_host = r#"{"url":"http://127.0.0.2:43123/?token=launch","host":"127.0.0.2","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        assert!(validated_ready(wrong_host, "0.1.2-alpha.1", 42, &expected).is_err());
    }

    #[test]
    fn ready_file_rejects_stale_generation_nonce_or_image() {
        let expected = generation();
        let stale_generation = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":6,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        let wrong_nonce = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"wrong","imageIdentity":"sha256:image-7"}"#;
        let wrong_image = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:wrong"}"#;
        for raw in [stale_generation, wrong_nonce, wrong_image] {
            assert!(validated_ready(raw, "0.1.2-alpha.1", 42, &expected).is_err());
        }
    }

    #[test]
    fn diagnostic_attribution_keeps_full_external_quarantine_set() {
        let rows = parse_config_dump_rows(DUMP);
        let (selected, suspected, reason) =
            recovery_plan(&rows, "failed to load @legacy/old-market-plugin");
        assert_eq!(selected.len(), 2);
        assert_eq!(suspected, vec!["old-market-plugin"]);
        assert_eq!(reason, "diagnostic-match");
    }

    #[cfg(unix)]
    #[test]
    fn runtime_work_dir_is_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = work_dir().unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_runtime_start_reclaims_its_private_work_dir() {
        let dir = work_dir().unwrap();
        {
            let _guard = WorkDirGuard::new(dir.clone());
            assert!(dir.is_dir());
        }
        assert!(!dir.exists());
    }
}
