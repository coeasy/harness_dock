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

pub(crate) async fn wait_for_managed_processes(app: tauri::AppHandle) {
    // Pacing uses `tokio::time::sleep` instead of a blocking `spawn_blocking`
    // + thread::sleep poll loop: the shutdown coordinator is fully async, no
    // blocking thread is tied up for up to 30s, and the deadline is derived
    // from a monotonic clock just like before. The `State` borrow is taken
    // inside each iteration so it never spans an `.await` point.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        stop_managed_processes(&app);
        let idle = {
            let state = app.state::<AppState>();
            let current = lifecycle::snapshot(&*state);
            process::starting_processes_empty(&state.starting_processes)
                && current.managed_operations_idle()
        };
        if idle {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            eprintln!(
                "HarnessDock shutdown timed out while waiting for actor lifecycle operations; forcing process exit."
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stop_managed_processes(&app);
}

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.revision.fetch_add(1, Ordering::AcqRel);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        wait_for_managed_processes(handle.clone()).await;
        handle.exit(0);
    });
}
