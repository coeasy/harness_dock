//! The blocking multi-attempt start loop and generation lease publication.

use super::*;

pub fn launch_attempt(
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
) -> Result<RuntimeProcess, AttemptFailure> {
    let (mut child, stdout, stderr, registration) = spawn_runtime(
        image,
        profile,
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

fn hard_rescue_profile(
    image: &RuntimeImage,
    embedded_patch_file: &Path,
    ready_file: &Path,
    dir: &Path,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<RuntimeProcess, String> {
    let safe_home = dir.join("rescue-dsh-home");
    fs::create_dir_all(&safe_home).map_err(|error| format!("无法创建救援 DSH_HOME: {error}"))?;
    let _ = fs::remove_file(ready_file);
    let mut process = launch_attempt(
        image,
        DEFAULT_PROFILE,
        &[embedded_patch_file],
        Some(&safe_home),
        ready_file,
        dir,
        "rescue-private-home",
        generation,
        token,
        starting_processes,
        quitting,
    )
    .map_err(|error| {
        format!(
            "Harness Web 救援模式启动失败: {}\n{}",
            error.message,
            public_diagnostic(&error.diagnostic)
        )
    })?;
    process.safe_mode = true;
    process.recovery_source = "rescue-web-private-home".into();
    Ok(process)
}

/// Start the normal shipped `web` profile with every third-party/user row from
/// the effective config disabled for this generation only.
///
/// Rescue mode intentionally keeps the effective DSH_HOME when config discovery
/// succeeds so model/settings state remains available. If even config discovery
/// is damaged, it falls back once to a private DSH_HOME so the official Web app
/// still has a deterministic last-resort startup path.
pub fn safe_profile(
    image: &RuntimeImage,
    launch: &RuntimeLaunchSpec,
    embedded_patch_file: &Path,
    ready_file: &Path,
    dir: &Path,
    diagnostic: Option<&str>,
    generation: &RuntimeGeneration,
    token: &CancellationToken,
    starting_processes: &process_control::StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<RuntimeProcess, String> {
    let rescue_launch = RuntimeLaunchSpec {
        profile: DEFAULT_PROFILE.into(),
        dsh_home: launch.dsh_home.clone(),
        startup_policy: RuntimeStartupPolicy::Safe,
    };
    let rows = match recovery_rows(
        image,
        &rescue_launch,
        embedded_patch_file,
        token,
        starting_processes,
        quitting,
    ) {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!(
                "Rescue Web config inventory failed; using private-home hard rescue: {error}"
            );
            return hard_rescue_profile(
                image,
                embedded_patch_file,
                ready_file,
                dir,
                generation,
                token,
                starting_processes,
                quitting,
            );
        }
    };
    let rescue = safe_mode::plan(&rows, diagnostic);
    let isolated_plugins = rescue.isolated_plugin_ids();
    let suspected_plugins = rescue.suspected_plugins.clone();
    let rescue_patch = rescue.patch()?;
    let rescue_patch_file = dir.join("rescue-web.patch.yml");
    let mut patches = vec![embedded_patch_file];
    if !rescue_patch.is_empty() {
        fs::write(&rescue_patch_file, rescue_patch)
            .map_err(|error| format!("无法写入救援模式插件隔离 patch: {error}"))?;
        patches.push(rescue_patch_file.as_path());
    }

    let _ = fs::remove_file(ready_file);
    let mut process = launch_attempt(
        image,
        DEFAULT_PROFILE,
        &patches,
        rescue_launch.dsh_home.as_deref(),
        ready_file,
        dir,
        "rescue-web",
        generation,
        token,
        starting_processes,
        quitting,
    )
    .map_err(|error| {
        format!(
            "Harness Web 救援模式启动失败: {}\n{}",
            error.message,
            public_diagnostic(&error.diagnostic)
        )
    })?;
    process.safe_mode = true;
    process.recovery_source = "rescue-web".into();
    process.isolated_plugins = isolated_plugins;
    process.suspected_plugins = suspected_plugins;
    Ok(process)
}

fn direct_failure(profile: &str, failure: AttemptFailure) -> String {
    format!(
        "dsh profile {profile:?} Direct 启动失败: {}\n{}",
        failure.message,
        public_diagnostic(&failure.diagnostic)
    )
}

fn launch_quarantine_scope(launch: &RuntimeLaunchSpec) -> String {
    let home = launch.dsh_home.clone().or_else(dsh_home_path);
    let home = home
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<unresolved>".into());
    format!("profile={}\ndsh_home={home}", launch.profile)
}

pub fn start_blocking(
    image: RuntimeImage,
    launch: RuntimeLaunchSpec,
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

    if force_safe_mode || launch.startup_policy == RuntimeStartupPolicy::Safe {
        return work_dir_guard.retain_result(safe_profile(
            &image,
            &launch,
            &patch_file,
            &ready_file,
            &dir,
            None,
            &generation,
            &token,
            &starting_processes,
            &quitting,
        ));
    }

    let launch_selected = |attempt: &str, ready_file: &Path| {
        launch_attempt(
            &image,
            &launch.profile,
            &[patch_file.as_path()],
            launch.dsh_home.as_deref(),
            ready_file,
            &dir,
            attempt,
            &generation,
            &token,
            &starting_processes,
            &quitting,
        )
    };

    if launch.startup_policy == RuntimeStartupPolicy::Direct {
        let _ = fs::remove_file(&ready_file);
        return match launch_selected("direct", &ready_file) {
            Ok(process) => {
                work_dir_guard.retain();
                Ok(process)
            }
            Err(failure) => Err(direct_failure(&launch.profile, failure)),
        };
    }

    // Existing automatic plugin attribution is intentionally restricted to
    // the shipped web profile. Other profiles may compose a very different
    // application tree; reusing web-centric quarantine attribution against
    // them can disable unrelated rows. They still get selected-profile startup
    // followed by Rescue Web.
    if launch.profile != DEFAULT_PROFILE {
        let _ = fs::remove_file(&ready_file);
        return match launch_selected("profile", &ready_file) {
            Ok(process) => {
                work_dir_guard.retain();
                Ok(process)
            }
            Err(failure) => {
                eprintln!(
                    "Selected profile {:?} failed in Auto mode; falling back to Rescue Web: {}",
                    launch.profile, failure.message
                );
                work_dir_guard.retain_result(safe_profile(
                    &image,
                    &launch,
                    &patch_file,
                    &ready_file,
                    &dir,
                    Some(&failure.diagnostic),
                    &generation,
                    &token,
                    &starting_processes,
                    &quitting,
                ))
            }
        };
    }

    let recovery_enabled =
        std::env::var("HARNESSDOCK_PLUGIN_RECOVERY").ok().as_deref() != Some("0");
    let quarantine_scope = launch_quarantine_scope(&launch);
    if recovery_enabled {
        if let Some(quarantine) = plugin_quarantine::read(
            &quarantine_state_path,
            &image.origin.dsh_version,
            &quarantine_scope,
        ) {
            let quarantine_file = dir.join("plugin-quarantine.patch.yml");
            fs::write(
                &quarantine_file,
                recovery_patch_ids(&quarantine.isolated_plugins)?,
            )
            .map_err(|error| format!("无法写入插件隔离 patch: {error}"))?;
            let _ = fs::remove_file(&ready_file);
            if let Ok(mut process) = launch_attempt(
                &image,
                &launch.profile,
                &[patch_file.as_path(), quarantine_file.as_path()],
                launch.dsh_home.as_deref(),
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
    match launch_selected("normal", &ready_file) {
        Ok(process) => {
            work_dir_guard.retain();
            Ok(process)
        }
        Err(first_failure) => {
            if cancelled(&token, &quitting) {
                return Err("Runtime generation cancelled during startup".into());
            }
            if !recovery_enabled {
                return Err(format!(
                    "{}\n{}",
                    first_failure.message,
                    public_diagnostic(&first_failure.diagnostic)
                ));
            }
            let rows = match recovery_rows(
                &image,
                &launch,
                &patch_file,
                &token,
                &starting_processes,
                &quitting,
            ) {
                Ok(rows) => rows,
                Err(error) => {
                    eprintln!("Plugin recovery config discovery failed; using Rescue Web: {error}");
                    return work_dir_guard.retain_result(safe_profile(
                        &image,
                        &launch,
                        &patch_file,
                        &ready_file,
                        &dir,
                        Some(&first_failure.diagnostic),
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
                    &launch,
                    &patch_file,
                    &ready_file,
                    &dir,
                    Some(&first_failure.diagnostic),
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
                &launch.profile,
                &[patch_file.as_path(), recovery_file.as_path()],
                launch.dsh_home.as_deref(),
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
                        &quarantine_scope,
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
                        &launch,
                        &patch_file,
                        &ready_file,
                        &dir,
                        Some(&first_failure.diagnostic),
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
