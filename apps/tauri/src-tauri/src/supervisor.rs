use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::Manager;

use crate::{gateway_host, lifecycle, process, runtime, AppState};

/// Synchronous, idempotent cleanup coordinated across Resource Actors. Runtime
/// and Gateway remain the only owners of their long-lived native resources.
pub(crate) fn stop_managed_processes(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    process::stop_starting_processes(&state.starting_processes);
    gateway_host::stop_managed(&state.gateway);
    runtime::stop_managed(&state.runtime_actor);
    if let Ok(mut surface) = state.surface_actor.lock() {
        surface.cancel_navigation();
        surface.end_operation();
    };
}

/// Process-tree termination can include OS calls and, on Unix, a short TERM ->
/// KILL grace period. Keep that work off the async runtime worker that drives
/// presentation/timers so shutdown feedback stays responsive under load.
async fn stop_managed_processes_blocking(app: tauri::AppHandle) {
    if let Err(error) = tauri::async_runtime::spawn_blocking(move || {
        stop_managed_processes(&app);
    })
    .await
    {
        eprintln!("HarnessDock managed process stop worker failed: {error}");
    }
}

pub(crate) async fn wait_for_managed_processes(app: tauri::AppHandle) {
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(30);
    let mut feedback_stage = 0_u8;

    // Shutdown admission is already closed (`quitting=true`), so no new managed
    // child may be published after this point. One strict stop pass is enough;
    // the loop below only observes ownership settling instead of repeatedly
    // issuing the same kill/lock sequence every 100ms.
    stop_managed_processes_blocking(app.clone()).await;

    loop {
        let idle = {
            let state = app.state::<AppState>();
            let current = lifecycle::snapshot(&*state);
            process::starting_processes_empty(&state.starting_processes)
                && current.managed_operations_idle()
        };
        if idle {
            break;
        }

        let elapsed = started.elapsed();
        if feedback_stage == 0 && elapsed >= Duration::from_secs(1) {
            crate::harness_window::set_primary_lifecycle_status(
                &app,
                "正在关闭 Runtime、Gateway 与后台任务…",
            );
            feedback_stage = 1;
        } else if feedback_stage == 1 && elapsed >= Duration::from_secs(5) {
            crate::harness_window::set_primary_lifecycle_status(
                &app,
                "正在等待受管进程安全退出…",
            );
            feedback_stage = 2;
        }

        if tokio::time::Instant::now() >= deadline {
            eprintln!(
                "HarnessDock shutdown timed out while waiting for actor lifecycle operations; forcing final cleanup."
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // A final idempotent pass is the no-orphan boundary for timeout/race/error
    // cases. Run it off-thread for the same reason as the initial drain.
    stop_managed_processes_blocking(app.clone()).await;
    crate::harness_window::set_primary_lifecycle_status(&app, "正在完成退出…");
}

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.revision.fetch_add(1, Ordering::AcqRel);

    // Once Harness Web has painted, exit feedback remains in that compositor
    // surface. Never reactivate the independent splash WebView during normal
    // shutdown: doing so can expose an unpainted WebView2 frame before process
    // cleanup starts.
    let overlay_visible = crate::harness_window::show_primary_lifecycle_overlay(
        app,
        "exit",
        "正在安全退出 HarnessDock…",
    );

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if overlay_visible {
            // Give the UI two or three compositor frames before any OS-level
            // process termination work begins.
            tokio::time::sleep(Duration::from_millis(48)).await;
        }
        wait_for_managed_processes(handle.clone()).await;
        handle.exit(0);
    });
}
