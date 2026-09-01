use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use url::Url;

use crate::{platform, plugin_quarantine, process as process_control, AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub app_url: Option<String>,
    pub dsh_version: Option<String>,
    pub pid: Option<u32>,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginInfo {
    dsh_version: String,
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
    work_dir: PathBuf,
    node: PathBuf,
    node_source: String,
    ready: ReadyInfo,
    recovery_source: String,
    isolated_plugins: Vec<String>,
    suspected_plugins: Vec<String>,
    quarantine_expires_at: Option<u64>,
    safe_mode: bool,
}

impl RuntimeProcess {
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: if self.safe_mode || !self.isolated_plugins.is_empty() { "degraded".into() } else { "ready".into() },
            app_url: Some(self.ready.url.clone()),
            dsh_version: Some(self.ready.dsh_version.clone()),
            pid: Some(self.ready.pid),
            recovery_mode: self.safe_mode || !self.isolated_plugins.is_empty(),
            recovery_source: self.recovery_source.clone(),
            isolated_plugins: self.isolated_plugins.clone(),
            suspected_plugins: self.suspected_plugins.clone(),
            quarantine_expires_at: self.quarantine_expires_at,
            safe_mode: self.safe_mode,
            node_source: self.node_source.clone(),
        }
    }

    pub(crate) fn gateway_inputs(&self) -> (PathBuf, String) {
        (self.node.clone(), self.ready.url.clone())
    }

    fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) | Err(_) => true,
        }
    }

    fn stop(&mut self) {
        process_control::stop_child_tree(&mut self.child);
        let _ = fs::remove_dir_all(&self.work_dir);
    }
}

struct RuntimeStartGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for RuntimeStartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stopped() -> RuntimeStatus {
    RuntimeStatus {
        state: "stopped".into(),
        app_url: None,
        dsh_version: None,
        pid: None,
        recovery_mode: false,
        recovery_source: "none".into(),
        isolated_plugins: Vec::new(),
        suspected_plugins: Vec::new(),
        quarantine_expires_at: None,
        safe_mode: false,
        node_source: "none".into(),
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

fn embedded_patch(plugin: &Path, compatibility: &Path) -> Result<String, String> {
    let plugin_path = platform::node_cli_path(plugin);
    let compatibility_path = platform::node_cli_path(compatibility);
    let plugin_url = Url::from_file_path(plugin_path)
        .map_err(|_| "无法把 embedded client 插件路径转换为 file URL。".to_string())?;
    let compatibility_url = Url::from_file_path(compatibility_path)
        .map_err(|_| "无法把客户端兼容层路径转换为 file URL。".to_string())?;
    let plugin_url = plugin_url.as_str().replace('\'', "''");
    let compatibility_url = compatibility_url.as_str().replace('\'', "''");
    Ok(format!(
        "- insert:\n    - id: embedded-client\n      name: '{plugin_url}'\n    - id: harnessdock-client-runtime-compat\n      name: '{compatibility_url}'\n"
    ))
}

fn decode_yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value).unwrap_or_else(|_| value[1..value.len().saturating_sub(1)].to_string());
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
            if let Some(row) = current.take() { rows.push(row); }
            source = label.split(", patched by ").next().unwrap_or(label).trim().to_string();
            continue;
        }
        if let Some(raw_id) = line.strip_prefix("- id:") {
            if let Some(row) = current.take() { rows.push(row); }
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
    if let Some(row) = current { rows.push(row); }
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
            row.id != "embedded-client"
                && row.id != "harnessdock-client-runtime-compat"
                && !row.source.is_empty()
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
    tokens.into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value.len() >= 3)
        .any(|value| haystack.contains(&value))
}

fn recovery_plan(rows: &[ConfigDumpRow], diagnostic: &str) -> (Vec<ConfigDumpRow>, Vec<String>, String) {
    let candidates = recovery_candidates(rows);
    let suspected = candidates
        .iter()
        .filter(|row| diagnostic_matches(row, diagnostic))
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
    let reason = if suspected.is_empty() { "ambiguous" } else { "diagnostic-match" }.to_string();
    (candidates, suspected, reason)
}

fn select_recovery_rows(rows: &[ConfigDumpRow], diagnostic: &str) -> Vec<ConfigDumpRow> {
    recovery_plan(rows, diagnostic).0
}

fn recovery_patch_ids(ids: &[String]) -> Result<String, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut output = String::new();
    for value in ids {
        if !seen.insert(value.clone()) { continue; }
        let id = serde_json::to_string(value).map_err(|error| error.to_string())?;
        output.push_str(&format!("- id: {id}\n  disabled: true\n"));
    }
    Ok(output)
}

fn recovery_patch(rows: &[ConfigDumpRow]) -> Result<String, String> {
    recovery_patch_ids(&rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>())
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

fn read_attempt_logs(stdout_path: &Path, stderr_path: &Path) -> String {
    let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
    let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
    let combined = format!("{stdout}\n{stderr}");
    if combined.chars().count() <= 32_000 { return combined; }
    combined.chars().rev().take(32_000).collect::<Vec<_>>().into_iter().rev().collect()
}

fn public_diagnostic(diagnostic: &str) -> String {
    let interesting: Vec<_> = diagnostic.lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.contains("http://")
                && !lower.contains("https://")
                && (lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("cannot")
                    || lower.contains("plugin")
                    || lower.contains("module"))
        })
        .take(24)
        .collect();
    if interesting.is_empty() { "dsh startup failed; see the application diagnostics for details".into() } else { interesting.join("\n") }
}

fn spawn_runtime(
    node: &Path,
    dsh: &Path,
    patches: &[&Path],
    dsh_home: Option<&Path>,
    ready_file: &Path,
    version: &str,
    dir: &Path,
    attempt: &str,
    starting_processes: &process_control::StartingProcessRegistry,
) -> Result<(Child, PathBuf, PathBuf, process_control::StartingProcessGuard), String> {
    let stdout_path = dir.join(format!("{attempt}.stdout.log"));
    let stderr_path = dir.join(format!("{attempt}.stderr.log"));
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("无法创建 Runtime stdout 日志: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("无法创建 Runtime stderr 日志: {error}"))?;

    let mut command = Command::new(platform::node_cli_path(node));
    command.arg(platform::node_cli_path(dsh)).args(["--profile", "web"]);
    for patch in patches {
        command.arg("--patch").arg(platform::node_cli_path(patch));
    }
    command
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("DSH_EMBEDDED_READY_FILE", platform::node_cli_path(ready_file))
        .env("DSH_EMBEDDED_VERSION", version)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(home) = dsh_home {
        command.env("DSH_HOME", platform::node_cli_path(home));
    }
    platform::configure_child_command(&mut command);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动本地 dsh Runtime: {error}"))?;
    let registration = process_control::register_starting_process(starting_processes, child.id());
    Ok((child, stdout_path, stderr_path, registration))
}

fn wait_for_ready(
    child: &mut Child,
    ready_file: &Path,
    expected_version: &str,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<ReadyInfo, AttemptFailure> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                return Err(AttemptFailure { message: format!("dsh Runtime 在 ready 前退出: {status}"), diagnostic });
            }
            Ok(None) => {}
            Err(error) => {
                let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                return Err(AttemptFailure { message: format!("无法检查 dsh Runtime 状态: {error}"), diagnostic });
            }
        }
        if let Ok(raw) = fs::read_to_string(ready_file) {
            match validated_ready(&raw, expected_version) {
                Ok(ready) => {
                    thread::sleep(Duration::from_millis(750));
                    match child.try_wait() {
                        Ok(None) => return Ok(ready),
                        Ok(Some(status)) => {
                            let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                            return Err(AttemptFailure { message: format!("dsh Runtime 在稳定窗口内退出: {status}"), diagnostic });
                        }
                        Err(error) => {
                            let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                            return Err(AttemptFailure { message: error.to_string(), diagnostic });
                        }
                    }
                }
                Err(error) if deadline <= Instant::now() => {
                    process_control::stop_child_tree(child);
                    let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                    return Err(AttemptFailure { message: error, diagnostic });
                }
                Err(_) => {}
            }
        }
        if deadline <= Instant::now() {
            process_control::stop_child_tree(child);
            let diagnostic = read_attempt_logs(stdout_path, stderr_path);
            return Err(AttemptFailure { message: "等待 dsh Runtime ready 超时。".into(), diagnostic });
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Last-resort boot path for a broken user profile. It uses a temporary,
/// host-owned DSH_HOME, so a malformed or crashing third-party plugin cannot
/// prevent the official Web UI from opening and the user's real configuration
/// is never rewritten.
fn start_safe_profile(
    node: &Path,
    node_source: &str,
    dsh: &Path,
    patch_file: &Path,
    ready_file: &Path,
    origin: &OriginInfo,
    dir: &Path,
    failure_context: &str,
    starting_processes: &process_control::StartingProcessRegistry,
) -> Result<RuntimeProcess, String> {
    let safe_home = dir.join("safe-dsh-home");
    fs::create_dir_all(&safe_home).map_err(|error| format!("无法创建 Runtime 安全配置目录: {error}"))?;
    let _ = fs::remove_file(ready_file);
    let (mut child, stdout_path, stderr_path, _registration) = spawn_runtime(
        node,
        dsh,
        &[patch_file],
        Some(safe_home.as_path()),
        ready_file,
        &origin.dsh_version,
        dir,
        "safe",
        starting_processes,
    )?;
    match wait_for_ready(
        &mut child,
        ready_file,
        &origin.dsh_version,
        &stdout_path,
        &stderr_path,
    ) {
        Ok(ready) => Ok(RuntimeProcess {
            child,
            work_dir: dir.to_path_buf(),
            node: node.to_path_buf(),
            node_source: node_source.to_string(),
            ready,
            recovery_source: "safe-profile".into(),
            isolated_plugins: Vec::new(),
            suspected_plugins: Vec::new(),
            quarantine_expires_at: None,
            safe_mode: true,
        }),
        Err(safe_failure) => {
            process_control::stop_child_tree(&mut child);
            let summary = public_diagnostic(&safe_failure.diagnostic);
            let _ = fs::remove_dir_all(dir);
            Err(format!(
                "{failure_context}\n安全配置启动也失败: {}\n{}",
                safe_failure.message, summary
            ))
        }
    }
}

fn dump_config(
    node: &Path,
    dsh: &Path,
    embedded_patch_file: &Path,
    default_only: bool,
) -> Result<String, String> {
    let mut command = Command::new(platform::node_cli_path(node));
    command.arg(platform::node_cli_path(dsh)).args(["--profile", "web"]);
    if default_only {
        command.arg("--dump-default-config");
    } else {
        command
            .args(["--patch"])
            .arg(platform::node_cli_path(embedded_patch_file))
            .arg("--dump-config");
    }
    command.stdin(Stdio::null());
    platform::configure_child_command(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("无法运行 dsh config dump: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "dsh {} 失败: {}",
            if default_only { "--dump-default-config" } else { "--dump-config" },
            String::from_utf8_lossy(&output.stderr).chars().take(2_000).collect::<String>()
        ));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("dsh --dump-config 输出不是 UTF-8: {error}"))
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

/// Read only the user patch IDs when the upstream boot-free full dump is
/// blocked by a malformed user layer. This parser intentionally understands
/// IDs/names only; it never evaluates YAML `!!js` or imports plugin modules.
fn user_patch_rows() -> Vec<ConfigDumpRow> {
    let Some(home) = dsh_home_path() else { return Vec::new() };
    let paths = [
        home.join("profiles").join("web").join("cordis.patch.yml"),
        home.join("cordis.patch.yml"),
    ];
    let mut rows = Vec::new();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        let source = path.to_string_lossy().into_owned();
        let mut current: Option<ConfigDumpRow> = None;
        for line in raw.lines() {
            let line = line.trim_start();
            if let Some(raw_id) = line.strip_prefix("- id:") {
                if let Some(row) = current.take() { rows.push(row); }
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
        if let Some(row) = current { rows.push(row); }
    }
    rows
}

fn recovery_rows(node: &Path, dsh: &Path, embedded_patch_file: &Path) -> Result<Vec<ConfigDumpRow>, String> {
    match dump_config(node, dsh, embedded_patch_file, false) {
        Ok(config) => Ok(parse_config_dump_rows(&config)),
        Err(full_error) => {
            let default_config = dump_config(node, dsh, embedded_patch_file, true).map_err(|default_error| {
                format!("{full_error}; 默认配置转储也失败: {default_error}")
            })?;
            let mut rows = parse_config_dump_rows(&default_config);
            rows.extend(user_patch_rows());
            Ok(rows)
        }
    }
}

fn start_with_node_fallback(
    runtime_root: PathBuf,
    plugin_path: PathBuf,
    compatibility_path: PathBuf,
    origin_path: PathBuf,
    quarantine_state_path: PathBuf,
    starting_processes: process_control::StartingProcessRegistry,
) -> Result<RuntimeProcess, String> {
    let normalized_root = platform::node_cli_path(&runtime_root);
    let bundled_node = node_path(&normalized_root);
    let (preferred_node, preferred_source) = platform::resolve_node(&bundled_node);

    if preferred_source != "system" {
        return start_blocking(
            runtime_root,
            plugin_path,
            compatibility_path,
            origin_path,
            quarantine_state_path,
            Some((preferred_node, preferred_source)),
            starting_processes,
        );
    }

    let system_error = match start_blocking(
        runtime_root.clone(),
        plugin_path.clone(),
        compatibility_path.clone(),
        origin_path.clone(),
        quarantine_state_path.clone(),
        Some((preferred_node, "system")),
        starting_processes.clone(),
    ) {
        Ok(process) => return Ok(process),
        Err(error) => error,
    };

    match start_blocking(
        runtime_root,
        plugin_path,
        compatibility_path,
        origin_path,
        quarantine_state_path,
        Some((bundled_node, "bundled")),
        starting_processes,
    ) {
        Ok(process) => Ok(process),
        Err(bundled_error) => Err(format!(
            "系统 Node 启动失败，已自动回退内置 Node，但仍未能打开 Harness Web。\\n系统 Node: {system_error}\\n内置 Node: {bundled_error}"
        )),
    }
}

fn start_blocking(
    runtime_root: PathBuf,
    plugin_path: PathBuf,
    compatibility_path: PathBuf,
    origin_path: PathBuf,
    quarantine_state_path: PathBuf,
    forced_node: Option<(PathBuf, &'static str)>,
    starting_processes: process_control::StartingProcessRegistry,
) -> Result<RuntimeProcess, String> {
    // Tauri can return verbatim Windows paths (\\?\\C:\\...). Node's
    // entry-point resolver on affected releases cannot execute those paths.
    let runtime_root = platform::node_cli_path(&runtime_root);
    let plugin_path = platform::node_cli_path(&plugin_path);
    let compatibility_path = platform::node_cli_path(&compatibility_path);
    let origin_path = platform::node_cli_path(&origin_path);
    let quarantine_state_path = platform::node_cli_path(&quarantine_state_path);
    let bundled_node = node_path(&runtime_root);
    let (node, node_source) = forced_node.unwrap_or_else(|| platform::resolve_node(&bundled_node));
    let dsh = dsh_path(&runtime_root);
    if !dsh.is_file() || (node_source == "bundled" && !bundled_node.is_file()) {
        return Err(format!("Tauri Full Runtime 不完整: node={} dsh={}", bundled_node.display(), dsh.display()));
    }
    if !plugin_path.is_file() || !compatibility_path.is_file() || !origin_path.is_file() {
        return Err("Tauri Runtime 缺少 origin.json、embedded-client 插件或客户端兼容层。".into());
    }
    let origin: OriginInfo = serde_json::from_str(&fs::read_to_string(&origin_path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("origin.json 无效: {error}"))?;
    let dir = work_dir()?;
    let patch_file = dir.join("embedded.patch.yml");
    let ready_file = dir.join("ready.json");
    fs::write(&patch_file, embedded_patch(&plugin_path, &compatibility_path)?)
        .map_err(|error| format!("无法写入 embedded patch: {error}"))?;
    let recovery_enabled = std::env::var("HARNESSDOCK_PLUGIN_RECOVERY").ok().as_deref() != Some("0");

    if recovery_enabled {
        if let Some(quarantine) = plugin_quarantine::read(&quarantine_state_path, &origin.dsh_version) {
            let quarantine_file = dir.join("plugin-quarantine.patch.yml");
            fs::write(&quarantine_file, recovery_patch_ids(&quarantine.isolated_plugins)?)
                .map_err(|error| format!("无法写入插件隔离 patch: {error}"))?;
            let _ = fs::remove_file(&ready_file);
            let (mut quarantine_child, quarantine_stdout, quarantine_stderr, _registration) = spawn_runtime(
                &node,
                &dsh,
                &[patch_file.as_path(), quarantine_file.as_path()],
                None,
                &ready_file,
                &origin.dsh_version,
                &dir,
                "quarantine",
                &starting_processes,
            )?;
            match wait_for_ready(
                &mut quarantine_child,
                &ready_file,
                &origin.dsh_version,
                &quarantine_stdout,
                &quarantine_stderr,
            ) {
                Ok(ready) => {
                    return Ok(RuntimeProcess {
                        child: quarantine_child,
                        work_dir: dir,
                        node: node.clone(),
                        node_source: node_source.to_string(),
                        ready,
                        recovery_source: "quarantine".into(),
                        isolated_plugins: quarantine.isolated_plugins,
                        suspected_plugins: quarantine.suspected_plugins,
                        quarantine_expires_at: Some(quarantine.expires_at),
                        safe_mode: false,
                    });
                }
                Err(_) => {
                    process_control::stop_child_tree(&mut quarantine_child);
                    let _ = plugin_quarantine::clear(&quarantine_state_path);
                    let _ = fs::remove_file(&ready_file);
                }
            }
        }
    }

    let (mut child, stdout_path, stderr_path, _registration) = spawn_runtime(
        &node,
        &dsh,
        &[patch_file.as_path()],
        None,
        &ready_file,
        &origin.dsh_version,
        &dir,
        "normal",
        &starting_processes,
    )?;
    match wait_for_ready(&mut child, &ready_file, &origin.dsh_version, &stdout_path, &stderr_path) {
        Ok(ready) => {
            return Ok(RuntimeProcess {
                child,
                work_dir: dir,
                node: node.clone(),
                node_source: node_source.to_string(),
                ready,
                recovery_source: "none".into(),
                isolated_plugins: Vec::new(),
                suspected_plugins: Vec::new(),
                quarantine_expires_at: None,
                safe_mode: false,
            });
        }
        Err(first_failure) => {
            process_control::stop_child_tree(&mut child);
            if !recovery_enabled {
                let summary = public_diagnostic(&first_failure.diagnostic);
                let _ = fs::remove_dir_all(&dir);
                return Err(format!("{}\n{}", first_failure.message, summary));
            }

            let config = match recovery_rows(&node, &dsh, &patch_file) {
                Ok(value) => value,
                Err(error) => {
                    let summary = public_diagnostic(&first_failure.diagnostic);
                    return start_safe_profile(
                        &node,
                        node_source,
                        &dsh,
                        &patch_file,
                        &ready_file,
                        &origin,
                        &dir,
                        &format!("{}\n{}\n插件兼容恢复未运行: {error}", first_failure.message, summary),
                        &starting_processes,
                    );
                }
            };
            let rows = config;
            let (selected, suspected_plugins, reason) = recovery_plan(&rows, &first_failure.diagnostic);
            if selected.is_empty() {
                let summary = public_diagnostic(&first_failure.diagnostic);
                return start_safe_profile(
                    &node,
                    node_source,
                    &dsh,
                    &patch_file,
                    &ready_file,
                    &origin,
                    &dir,
                    &format!("{}\n{}\n未找到可隔离的第三方插件", first_failure.message, summary),
                    &starting_processes,
                );
            }

            let recovery_file = dir.join("plugin-recovery.patch.yml");
            fs::write(&recovery_file, recovery_patch(&selected)?).map_err(|error| format!("无法写入插件兼容恢复 patch: {error}"))?;
            let _ = fs::remove_file(&ready_file);
            let isolated_plugins: Vec<String> = selected.iter().map(|row| row.id.clone()).collect();
            let (mut recovery_child, recovery_stdout, recovery_stderr, _registration) = match spawn_runtime(
                &node,
                &dsh,
                &[patch_file.as_path(), recovery_file.as_path()],
                None,
                &ready_file,
                &origin.dsh_version,
                &dir,
                "recovery",
                &starting_processes,
            ) {
                Ok(value) => value,
                Err(error) => {
                    return start_safe_profile(
                        &node,
                        node_source,
                        &dsh,
                        &patch_file,
                        &ready_file,
                        &origin,
                        &dir,
                        &format!("插件兼容恢复进程无法启动: {error}"),
                        &starting_processes,
                    );
                }
            };
            match wait_for_ready(
                &mut recovery_child,
                &ready_file,
                &origin.dsh_version,
                &recovery_stdout,
                &recovery_stderr,
            ) {
                Ok(ready) => {
                    let quarantine = plugin_quarantine::write(
                        &quarantine_state_path,
                        &origin.dsh_version,
                        isolated_plugins.clone(),
                        suspected_plugins.clone(),
                        &reason,
                    ).ok();
                    Ok(RuntimeProcess {
                        child: recovery_child,
                        work_dir: dir,
                        node: node.clone(),
                        node_source: node_source.to_string(),
                        ready,
                        recovery_source: "startup-failure".into(),
                        isolated_plugins,
                        suspected_plugins,
                        quarantine_expires_at: quarantine.map(|value| value.expires_at),
                        safe_mode: false,
                    })
                }
                Err(recovery_failure) => {
                    process_control::stop_child_tree(&mut recovery_child);
                    let first_summary = public_diagnostic(&first_failure.diagnostic);
                    let recovery_summary = public_diagnostic(&recovery_failure.diagnostic);
                    start_safe_profile(
                        &node,
                        node_source,
                        &dsh,
                        &patch_file,
                        &ready_file,
                        &origin,
                        &dir,
                        &format!(
                            "dsh 正常启动失败，插件兼容恢复也失败。\n正常启动: {}\n{}\n恢复启动: {}\n{}",
                            first_failure.message,
                            first_summary,
                            recovery_failure.message,
                            recovery_summary,
                        ),
                        &starting_processes,
                    )
                }
            }
        }
    }
}

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    let Ok(mut guard) = state.runtime.lock() else { return stopped() };
    if guard.as_mut().is_some_and(|process| !process.is_alive()) {
        guard.take();
    }
    guard.as_ref().map(RuntimeProcess::status).unwrap_or_else(stopped)
}

#[tauri::command]
pub async fn runtime_start(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    if cfg!(mobile) {
        return Err("Android/iOS 使用 Remote Gateway，不允许在移动设备内启动桌面 dsh Runtime。".into());
    }
    if state.quitting.load(Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝新的 Runtime 启动。".into());
    }
    {
        let mut guard = state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
        if let Some(current) = guard.as_mut() {
            if current.is_alive() {
                return Ok(current.status());
            }
            guard.take();
        }
    }
    if state.runtime_starting.swap(true, Ordering::Acquire) {
        return Err("Runtime 正在启动，请稍候再试。".into());
    }
    let _starting = RuntimeStartGuard(&state.runtime_starting);
    let runtime_root = resource_path(&app, "dsh-runtime")?;
    let plugin_path = resource_path(&app, "plugin-embedded-client/index.js")?;
    let compatibility_path = resource_path(&app, "dsh-client-runtime-compat/index.js")?;
    let origin_path = resource_path(&app, "origin.json")?;
    let quarantine_state_path = quarantine_path(&app)?;
    let starting_processes = std::sync::Arc::clone(&state.starting_processes);
    let process = tauri::async_runtime::spawn_blocking(move || {
        start_with_node_fallback(
            runtime_root,
            plugin_path,
            compatibility_path,
            origin_path,
            quarantine_state_path,
            starting_processes,
        )
    })
        .await
        .map_err(|error| format!("Runtime 启动任务失败: {error}"))??;
    let status = process.status();
    let mut guard = state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
    if state.quitting.load(Ordering::Acquire) {
        let mut process = process;
        process.stop();
        return Err("HarnessDock 已进入退出流程，Runtime 未继续运行。".into());
    }
    *guard = Some(process);
    Ok(status)
}

#[tauri::command]
pub async fn runtime_restart(app: AppHandle) -> Result<RuntimeStatus, String> {
    {
        let state = app.state::<AppState>();
        crate::gateway_host::stop_managed(&state.gateway);
        runtime_stop(state)?;
    }
    let state = app.state::<AppState>();
    runtime_start(app.clone(), state).await
}

#[tauri::command]
pub fn runtime_stop(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    let mut guard = state.runtime.lock().map_err(|_| "Runtime 状态锁已损坏。".to_string())?;
    if let Some(mut process) = guard.take() {
        process.stop();
    }
    Ok(stopped())
}

#[tauri::command]
pub fn runtime_clear_plugin_quarantine(app: AppHandle) -> Result<(), String> {
    plugin_quarantine::clear(&quarantine_path(&app)?)
}

pub(crate) fn stop_managed(runtime: &Mutex<Option<RuntimeProcess>>) {
    if let Ok(mut guard) = runtime.lock() {
        if let Some(mut process) = guard.take() {
            process.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = "# == @deepseek-ai/dsh-bundle-base\n- id: official-core\n  name: '@deepseek-ai/plugin-core'\n# == third-party-bundle\n- id: old-market-plugin\n  name: '@legacy/old-market-plugin'\n# == C:\\Users\\me\\.dsh\\profiles\\web\\cordis.patch.yml\n- id: user-added\n  name: 'file:///C:/Users/me/plugin.js'\n# == C:\\Temp\\embedded.patch.yml\n- id: embedded-client\n  name: 'file:///C:/HarnessDock/embedded.js'\n";

    #[test]
    fn config_dump_parser_keeps_origins_and_names() {
        let rows = parse_config_dump_rows(DUMP);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].id, "official-core");
        assert_eq!(rows[1].source, "third-party-bundle");
        assert_eq!(rows[2].name.as_deref(), Some("file:///C:/Users/me/plugin.js"));
    }

    #[test]
    fn recovery_never_targets_official_or_embedded_rows() {
        let rows = parse_config_dump_rows(DUMP);
        let candidates = recovery_candidates(&rows);
        assert_eq!(candidates.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["old-market-plugin", "user-added"]);
    }

    #[test]
    fn embedded_patch_includes_the_legacy_client_runtime_compatibility_row() {
        let patch = embedded_patch(Path::new("/tmp/embedded.js"), Path::new("/tmp/compat/index.js")).unwrap();
        assert!(patch.contains("id: embedded-client"));
        assert!(patch.contains("id: harnessdock-client-runtime-compat"));
        assert!(patch.contains("file:///tmp/compat/index.js"));
    }

    #[test]
    fn recovery_isolates_all_external_rows_and_attributes_the_first_failure() {
        let rows = parse_config_dump_rows(DUMP);
        let (selected, suspected, reason) = recovery_plan(&rows, "failed to load @legacy/old-market-plugin");
        assert_eq!(selected.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["old-market-plugin", "user-added"]);
        assert_eq!(suspected, vec!["old-market-plugin"]);
        assert_eq!(reason, "diagnostic-match");
        assert_eq!(select_recovery_rows(&rows, "failed to load @legacy/old-market-plugin").len(), 2);
    }

    #[test]
    fn ambiguous_failure_falls_back_to_external_rows_only() {
        let rows = parse_config_dump_rows(DUMP);
        let (selected, suspected, reason) = recovery_plan(&rows, "Cordis boot failed");
        assert_eq!(selected.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["old-market-plugin", "user-added"]);
        assert!(suspected.is_empty());
        assert_eq!(reason, "ambiguous");
        assert!(recovery_patch(&selected).unwrap().contains("disabled: true"));
    }
}
