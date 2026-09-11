//! Process spawning, readiness probing and config dumps for a Runtime image.

use super::*;

pub struct WorkDirGuard {
    pub path: PathBuf,
    pub retained: bool,
}

impl WorkDirGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path, retained: false }
    }

    pub fn retain(&mut self) {
        self.retained = true;
    }

    pub fn retain_result<T>(&mut self, result: Result<T, String>) -> Result<T, String> {
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

pub fn validated_ready(
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
        return Err("Runtime ready.json generation/nonce/imageIdentity 未通过当前启动代际校验。".into());
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

pub fn read_attempt_logs(stdout_path: &Path, stderr_path: &Path) -> String {
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

pub fn public_diagnostic(diagnostic: &str) -> String {
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

pub fn cancelled(token: &CancellationToken, quitting: &std::sync::atomic::AtomicBool) -> bool {
    token.is_cancelled() || quitting.load(Ordering::Acquire)
}

pub fn spawn_runtime(
    image: &RuntimeImage,
    profile: &str,
    patches: &[&Path],
    dsh_home: Option<&Path>,
    ready_file: &Path,
    dir: &Path,
    attempt: &str,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<(Child, PathBuf, PathBuf, process_control::StartingProcessGuard), String> {
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
        .arg("--profile")
        .arg(profile);
    for patch in patches {
        command.arg("--patch").arg(platform::node_cli_path(patch));
    }
    command
        .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("DSH_EMBEDDED_READY_FILE", platform::node_cli_path(ready_file))
        .env("DSH_EMBEDDED_VERSION", &image.origin.dsh_version)
        .env("HARNESSDOCK_RUNTIME_GENERATION", generation.id.to_string())
        .env("HARNESSDOCK_RUNTIME_NONCE", &generation.nonce)
        .env("HARNESSDOCK_RUNTIME_IMAGE_IDENTITY", &generation.image_identity)
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

pub fn wait_for_ready(
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

pub fn dump_config(
    image: &RuntimeImage,
    launch: &RuntimeLaunchSpec,
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
        .arg("--profile")
        .arg(&launch.profile);
    if default_only {
        command.arg("--dump-default-config");
    } else {
        command
            .arg("--patch")
            .arg(platform::node_cli_path(embedded_patch_file))
            .arg("--dump-config");
    }
    if let Some(home) = launch.dsh_home.as_deref() {
        command.env("DSH_HOME", platform::node_cli_path(home));
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
                    return Err(String::from_utf8_lossy(&output.stderr).chars().take(2_000).collect());
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

#[cfg(test)]
mod tests {
    use super::*;

    pub fn generation() -> RuntimeGeneration {
        RuntimeGeneration {
            id: 7,
            nonce: "nonce-7".into(),
            image_identity: "sha256:image-7".into(),
            mode: RuntimeMode::Normal,
        }
    }

    #[test]
    pub fn ready_file_must_belong_to_spawned_process_managed_origin_and_generation() {
        let expected = generation();
        let raw = r#"{"url":"http://127.0.0.1:43123/?token=launch","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        assert!(validated_ready(raw, "0.1.2-alpha.1", 41, &expected).is_err());
        assert!(validated_ready(raw, "0.1.2-alpha.1", 42, &expected).is_ok());
        let wrong_host = r#"{"url":"http://127.0.0.2:43123/?token=launch","host":"127.0.0.2","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        assert!(validated_ready(wrong_host, "0.1.2-alpha.1", 42, &expected).is_err());
    }

    #[test]
    pub fn ready_file_rejects_stale_generation_nonce_or_image() {
        let expected = generation();
        let stale_generation = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":6,"nonce":"nonce-7","imageIdentity":"sha256:image-7"}"#;
        let wrong_nonce = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"wrong","imageIdentity":"sha256:image-7"}"#;
        let wrong_image = r#"{"url":"http://127.0.0.1:43123/","host":"127.0.0.1","port":43123,"pid":42,"dshVersion":"0.1.2-alpha.1","generation":7,"nonce":"nonce-7","imageIdentity":"sha256:wrong"}"#;
        for raw in [stale_generation, wrong_nonce, wrong_image] {
            assert!(validated_ready(raw, "0.1.2-alpha.1", 42, &expected).is_err());
        }
    }

    #[test]
    pub fn failed_runtime_start_reclaims_its_private_work_dir() {
        let dir = work_dir().unwrap();
        {
            let _guard = WorkDirGuard::new(dir.clone());
            assert!(dir.is_dir());
        }
        assert!(!dir.exists());
    }
}
