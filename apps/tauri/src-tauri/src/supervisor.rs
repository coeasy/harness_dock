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
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            stop_managed_processes(&app);
            let current = lifecycle::snapshot(&*state);
            if process::starting_processes_empty(&state.starting_processes)
                && current.managed_operations_idle()
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!(
                    "HarnessDock shutdown timed out while waiting for actor lifecycle operations; forcing process exit."
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        stop_managed_processes(&app);
    })
    .await;
}

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut desired) = state.desired.lock() {
        desired.app = crate::reconciler::AppDesiredState::Exiting;
        desired.revision = desired.revision.saturating_add(1);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        wait_for_managed_processes(handle.clone()).await;
        handle.exit(0);
    });
}
