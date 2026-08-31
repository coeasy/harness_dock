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
    pub recovery_mode: bool,
    pub isolated_plugins: Vec<String>,
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
    runtime_root: PathBuf,
    ready: ReadyInfo,
    isolated_plugins: Vec<String>,
}

impl RuntimeProcess {
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: if self.isolated_plugins.is_empty() { "ready".into() } else { "degraded".into() },
            app_url: Some(self.ready.url.clone()),
            dsh_version: Some(self.ready.dsh_version.clone()),
            pid: Some(self.ready.pid),
            recovery_mode: !self.isolated_plugins.is_empty(),
            isolated_plugins: self.isolated_plugins.clone(),
        }
    }

    pub(crate) fn gateway_inputs(&self) -> (PathBuf, String) {
        (node_path(&self.runtime_root), self.ready.url.clone())
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
    RuntimeStatus {
        state: "stopped".into(),
        app_url: None,
        dsh_version: None,
        pid: None,
        recovery_mode: false,
        isolated_plugins: Vec::new(),
    }
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

fn recovery_candidates(rows: &[ConfigDumpRow]) -> Vec<ConfigDumpRow> {
    rows.iter()
        .filter(|row| row.id != "embedded-client" && !row.source.is_empty() && !is_official_source(&row.source))
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

fn select_recovery_rows(rows: &[ConfigDumpRow], diagnostic: &str) -> Vec<ConfigDumpRow> {
    let candidates = recovery_candidates(rows);
    let matched: Vec<_> = candidates.iter().filter(|row| diagnostic_matches(row, diagnostic)).cloned().collect();
    if matched.is_empty() { candidates } else { matched }
}

fn recovery_patch(rows: &[ConfigDumpRow]) -> Result<String, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut output = String::new();
    for row in rows {
        if !seen.insert(row.id.clone()) { continue; }
        let id = serde_json::to_string(&row.id).map_err(|error| error.to_string())?;
        output.push_str(&format!("- id: {id}\n  disabled: true\n"));
    }
    Ok(output)
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
    ready_file: &Path,
    version: &str,
    dir: &Path,
    attempt: &str,
) -> Result<(Child, PathBuf, PathBuf), String> {
    let stdout_path = dir.join(format!("{attempt}.stdout.log"));
    let stderr_path = dir.join(format!("{attempt}.stderr.log"));
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("无法创建 Runtime stdout 日志: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("无法创建 Runtime stderr 日志: {error}"))?;

    let mut command = Command::new(node);
    command.arg(dsh).args(["--profile", "web"]);
    for patch in patches {
        command.arg("--patch").arg(patch);
    }
    let child = command
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("DSH_EMBEDDED_READY_FILE", ready_file)
        .env("DSH_EMBEDDED_VERSION", version)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("无法启动本地 dsh Runtime: {error}"))?;
    Ok((child, stdout_path, stderr_path))
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
                    let _ = child.kill();
                    let _ = child.wait();
                    let diagnostic = read_attempt_logs(stdout_path, stderr_path);
                    return Err(AttemptFailure { message: error, diagnostic });
                }
                Err(_) => {}
            }
        }
        if deadline <= Instant::now() {
            let _ = child.kill();
            let _ = child.wait();
            let diagnostic = read_attempt_logs(stdout_path, stderr_path);
            return Err(AttemptFailure { message: "等待 dsh Runtime ready 超时。".into(), diagnostic });
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn dump_config(node: &Path, dsh: &Path, embedded_patch_file: &Path) -> Result<String, String> {
    let output = Command::new(node)
        .arg(dsh)
        .args(["--profile", "web", "--patch"])
        .arg(embedded_patch_file)
        .arg("--dump-config")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法运行 dsh --dump-config: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "dsh --dump-config 失败: {}",
            String::from_utf8_lossy(&output.stderr).chars().take(2_000).collect::<String>()
        ));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("dsh --dump-config 输出不是 UTF-8: {error}"))
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

    let (mut child, stdout_path, stderr_path) = spawn_runtime(
        &node,
        &dsh,
        &[patch_file.as_path()],
        &ready_file,
        &origin.dsh_version,
        &dir,
        "normal",
    )?;
    match wait_for_ready(&mut child, &ready_file, &origin.dsh_version, &stdout_path, &stderr_path) {
        Ok(ready) => {
            return Ok(RuntimeProcess { child, work_dir: dir, runtime_root, ready, isolated_plugins: Vec::new() });
        }
        Err(first_failure) => {
            let _ = child.kill();
            let _ = child.wait();
            if std::env::var("HARNESSDOCK_PLUGIN_RECOVERY").ok().as_deref() == Some("0") {
                let summary = public_diagnostic(&first_failure.diagnostic);
                let _ = fs::remove_dir_all(&dir);
                return Err(format!("{}\n{}", first_failure.message, summary));
            }

            let config = match dump_config(&node, &dsh, &patch_file) {
                Ok(value) => value,
                Err(error) => {
                    let summary = public_diagnostic(&first_failure.diagnostic);
                    let _ = fs::remove_dir_all(&dir);
                    return Err(format!("{}\n{}\n插件兼容恢复未运行: {error}", first_failure.message, summary));
                }
            };
            let rows = parse_config_dump_rows(&config);
            let selected = select_recovery_rows(&rows, &first_failure.diagnostic);
            if selected.is_empty() {
                let summary = public_diagnostic(&first_failure.diagnostic);
                let _ = fs::remove_dir_all(&dir);
                return Err(format!("{}\n{}", first_failure.message, summary));
            }

            let recovery_file = dir.join("plugin-recovery.patch.yml");
            fs::write(&recovery_file, recovery_patch(&selected)?).map_err(|error| format!("无法写入插件兼容恢复 patch: {error}"))?;
            let _ = fs::remove_file(&ready_file);
            let isolated_plugins: Vec<String> = selected.iter().map(|row| row.id.clone()).collect();
            let (mut recovery_child, recovery_stdout, recovery_stderr) = spawn_runtime(
                &node,
                &dsh,
                &[patch_file.as_path(), recovery_file.as_path()],
                &ready_file,
                &origin.dsh_version,
                &dir,
                "recovery",
            )?;
            match wait_for_ready(
                &mut recovery_child,
                &ready_file,
                &origin.dsh_version,
                &recovery_stdout,
                &recovery_stderr,
            ) {
                Ok(ready) => Ok(RuntimeProcess {
                    child: recovery_child,
                    work_dir: dir,
                    runtime_root,
                    ready,
                    isolated_plugins,
                }),
                Err(recovery_failure) => {
                    let _ = recovery_child.kill();
                    let _ = recovery_child.wait();
                    let first_summary = public_diagnostic(&first_failure.diagnostic);
                    let recovery_summary = public_diagnostic(&recovery_failure.diagnostic);
                    let _ = fs::remove_dir_all(&dir);
                    Err(format!(
                        "dsh 正常启动失败，插件兼容恢复也失败。\n正常启动: {}\n{}\n恢复启动: {}\n{}",
                        first_failure.message,
                        first_summary,
                        recovery_failure.message,
                        recovery_summary,
                    ))
                }
            }
        }
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
    fn recovery_prefers_the_row_named_by_the_failure() {
        let rows = parse_config_dump_rows(DUMP);
        let selected = select_recovery_rows(&rows, "failed to load @legacy/old-market-plugin");
        assert_eq!(selected.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["old-market-plugin"]);
    }

    #[test]
    fn ambiguous_failure_falls_back_to_external_rows_only() {
        let rows = parse_config_dump_rows(DUMP);
        let selected = select_recovery_rows(&rows, "Cordis boot failed");
        assert_eq!(selected.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["old-market-plugin", "user-added"]);
        assert!(recovery_patch(&selected).unwrap().contains("disabled: true"));
    }
}
