use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::Manager;

use crate::{gateway_host, lifecycle, process, runtime, AppState};

/// Synchronous, idempotent child cleanup used by normal shutdown and updater
/// handoff. Runtime/Gateway remain the owners of their child handles; the
/// supervisor only coordinates the cross-service shutdown order.
pub(crate) fn stop_managed_processes(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    process::stop_starting_processes(&state.starting_processes);
    gateway_host::stop_managed(&state.gateway);
    runtime::stop_managed(&state.runtime);
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
                    "HarnessDock shutdown timed out while waiting for lifecycle operations; forcing process exit."
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // One final idempotent pass covers a startup task that published its
        // Child just as the last registry/lifecycle observation completed.
        stop_managed_processes(&app);
    })
    .await;
}

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }

    // Do not terminate Tauri until every admitted Runtime/Gateway lifecycle
    // operation has returned to idle. This closes shutdown races not only with
    // startup, but also with an in-flight managed restart/stop transition.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        wait_for_managed_processes(handle.clone()).await;
        handle.exit(0);
    });
}
