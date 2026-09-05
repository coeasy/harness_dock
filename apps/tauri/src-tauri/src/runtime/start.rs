//! The blocking multi-attempt start loop and generation lease publication.


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


pub fn launch_attempt(
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

pub fn safe_profile(
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

pub fn start_blocking(
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

pub fn lease_from_process(
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
