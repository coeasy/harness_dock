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

fn profile_writer_lock_diagnostic(diagnostic: &str) -> bool {
    let diagnostic = diagnostic.to_ascii_lowercase();
    diagnostic.contains("node_modules.lock")
        || diagnostic.contains("timed out waiting for the writer lock")
        || (diagnostic.contains("atomic-write") && diagnostic.contains("writer lock"))
}

fn profile_writer_lock_failure(failure: &AttemptFailure) -> bool {
    profile_writer_lock_diagnostic(&failure.diagnostic)
}

/// Start the shipped Web application from a private DSH_HOME.
///
/// Rescue is an availability boundary, not only a plugin-disable patch. It must
/// never compose the same user profile that just failed: profile composition can
/// itself be blocked by `profiles/node_modules.lock`, corrupt state, or another
/// dsh writer. We inspect user patch files directly for diagnostics only, then
/// launch the official Web profile in a generation-private home with the three
/// HarnessDock embedded integrations. The private home is owned by the Runtime
/// work directory and is removed when that Runtime generation stops.
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
    // Reading patch files is side-effect free and, unlike `dsh --dump-config`,
    // cannot enter profile healing or contend on the upstream writer lock.
    // These rows are metadata only: actual isolation comes from the private
    // DSH_HOME used below, so an incomplete inventory cannot weaken Rescue.
    let rows = user_patch_rows(DEFAULT_PROFILE, launch.dsh_home.as_deref());
    let rescue = safe_mode::plan(&rows, diagnostic);
    let isolated_plugins = rescue.isolated_plugin_ids();
    let suspected_plugins = rescue.suspected_plugins.clone();

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
    process.recovery_source = if diagnostic.is_some_and(profile_writer_lock_diagnostic) {
        "profile-lock-private-home".into()
    } else {
        "rescue-web-private-home".into()
    };
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
    // followed by private-home Rescue Web.
    if launch.profile != DEFAULT_PROFILE {
        let _ = fs::remove_file(&ready_file);
        return match launch_selected("profile", &ready_file) {
            Ok(process) => {
                work_dir_guard.retain();
                Ok(process)
            }
            Err(failure) => {
                eprintln!(
                    "Selected profile {:?} failed in Auto mode; falling back to private Rescue Web: {}",
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
            match launch_attempt(
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
                Ok(mut process) => {
                    process.recovery_source = "quarantine".into();
                    process.isolated_plugins = quarantine.isolated_plugins;
                    process.suspected_plugins = quarantine.suspected_plugins;
                    process.quarantine_expires_at = Some(quarantine.expires_at);
                    work_dir_guard.retain();
                    return Ok(process);
                }
                Err(failure) => {
                    let _ = plugin_quarantine::clear(&quarantine_state_path);
                    if profile_writer_lock_failure(&failure) {
                        eprintln!(
                            "Quarantine startup hit the profile writer lock; switching directly to private Rescue Web."
                        );
                        return work_dir_guard.retain_result(safe_profile(
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
                        ));
                    }
                }
            }
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

            // A writer-lock failure is profile state contention, not plugin
            // attribution. Any dump-config/quarantine attempt against the same
            // DSH_HOME would contend on the same lock and only delay Web
            // availability. Fail over immediately to a generation-private home.
            if profile_writer_lock_failure(&first_failure) {
                eprintln!(
                    "Normal startup hit the profile writer lock; switching directly to private Rescue Web."
                );
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
                    eprintln!("Plugin recovery config discovery failed; using private Rescue Web: {error}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(diagnostic: &str) -> AttemptFailure {
        AttemptFailure {
            message: "dsh Runtime 在 ready 前退出: exit code: 1".into(),
            diagnostic: diagnostic.into(),
        }
    }

    #[test]
    fn detects_upstream_profile_writer_lock_failures() {
        assert!(profile_writer_lock_failure(&failure(
            "Error: atomic-write: timed out waiting for the writer lock at C:\\Users\\runner\\.dsh\\profiles\\node_modules.lock"
        )));
        assert!(profile_writer_lock_failure(&failure(
            "failed while opening /home/me/.dsh/profiles/node_modules.lock"
        )));
        assert!(!profile_writer_lock_failure(&failure(
            "failed to import loader entry @vendor/example-plugin"
        )));
    }
}
