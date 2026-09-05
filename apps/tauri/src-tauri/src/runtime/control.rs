//! Tauri commands and actor-facing lifecycle helpers for the Runtime.


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


pub(crate) fn current_lease(state: &AppState) -> Option<RuntimeLease> {
    // Poisoning only means a previous holder panicked; the lease it protects is
    // still structurally valid, so read it back instead of reporting a failure
    // for a transient that the caller cannot act on.
    state.runtime_actor.lock().recover("RuntimeActor").lease()
}

pub(crate) fn live_lease(state: &AppState) -> Option<RuntimeLease> {
    // `live_lease` is an explicit lifecycle path: callers want a lease that is
    // still backed by a live process. Reaping a dead process here is intended.
    let _ = status_snapshot(state);
    current_lease(state)
}

pub fn mark_start_failed(state: &AppState, generation: u64, error: String) -> String {
    state
        .runtime_actor
        .lock()
        .recover("RuntimeActor")
        .mark_failed(generation, error.clone());
    error
}

pub(crate) fn status_snapshot(state: &AppState) -> RuntimeStatus {
    let mut actor = state.runtime_actor.lock().recover("RuntimeActor");
    let reaped = actor.reap_if_dead();
    if let Some(mut process) = reaped {
        drop(actor);
        process.stop();
        crate::gateway_host::stop_managed(&state.gateway);
        return phase_status(RuntimePhase::Stopped, None);
    }
    let lease = actor.lease();
    if let Some(process) = actor.process() {
        return process.status(lease.as_ref());
    }
    phase_status(actor.phase(), actor.generation_id())
}

/// Read-only runtime snapshot. Never mutates actor liveness state and never
/// stops processes or the gateway. Use this from diagnostics, status commands,
/// startup checks and other paths that must not revoke a live RuntimeLease;
/// only explicit lifecycle paths (`live_lease`, `runtime_status` command,
/// supervisor shutdown) may use the reaping `status_snapshot`.
pub(crate) fn status_snapshot_readonly(state: &AppState) -> RuntimeStatus {
    let actor = state.runtime_actor.lock().recover("RuntimeActor");
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

    // Starting the Runtime must not reap a process merely because a status
    // check is being performed: `start_impl` is an explicit lifecycle action
    // but the pre-check below only describes current state. Use the read-only
    // snapshot so a healthy running Runtime (degraded via safe-mode, for
    // example) is reported as-is instead of being torn down by inspection.
    let existing = status_snapshot_readonly(&*state);
    if existing.app_url.is_some() {
        return Ok(existing);
    }

    let (generation, token) = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| lock_err("RuntimeActor"))?;
        actor.begin_start(mode)?
    };
    let image = match load_runtime_image(&app) {
        Ok(image) => image,
        Err(error) => {
            return Err(mark_start_failed(&*state, generation.id, error));
        }
    };
    let generation = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| lock_err("RuntimeActor"))?;
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
            .map_err(|_| lock_err("RuntimeActor"))?;
        if let Err(mut stale) = actor.publish_ready(generation.id, process, lease, degraded) {
            stale.stop();
            return Err("陈旧 Runtime generation 已被丢弃。".into());
        }
        if let Some(process) = actor.process() {
            process.registration.complete();
        }
    }
    startup_trace::mark(StartupPhase::RuntimeReady);
    // Publication is already the authoritative readiness transition. Do not
    // immediately re-enter status_snapshot(), because that path owns explicit
    // liveness reconciliation. Return a read-only snapshot of the generation
    // that was just published so the startup coordinator cannot lose its lease
    // between RuntimeReady and WebviewRequested.
    let actor = state.runtime_actor.lock().recover("RuntimeActor");
    let lease = actor.lease();
    if let Some(process) = actor.process() {
        Ok(process.status(lease.as_ref()))
    } else {
        Ok(phase_status(actor.phase(), actor.generation_id()))
    }
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

pub fn stop_impl(state: &AppState) -> Result<RuntimeStatus, String> {
    crate::gateway_host::stop_managed(&state.gateway);
    let process = {
        let mut actor = state
            .runtime_actor
            .lock()
            .map_err(|_| lock_err("RuntimeActor"))?;
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
            .map_err(|_| lock_err("RuntimeActor"))?;
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
