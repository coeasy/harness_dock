use std::{
    collections::HashSet,
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

/// Processes that have been spawned but are not yet owned by Runtime/Gateway
/// state. This closes the shutdown race where the app exits while a blocking
/// startup task is still waiting for its ready file.
pub(crate) type StartingProcessRegistry = Arc<Mutex<HashSet<u32>>>;

pub(crate) struct StartingProcessGuard {
    registry: StartingProcessRegistry,
    pid: u32,
}

impl Drop for StartingProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut pids) = self.registry.lock() {
            pids.remove(&self.pid);
        }
    }
}

pub(crate) fn register_starting_process(
    registry: &StartingProcessRegistry,
    pid: u32,
) -> StartingProcessGuard {
    if let Ok(mut pids) = registry.lock() {
        pids.insert(pid);
    }
    StartingProcessGuard {
        registry: Arc::clone(registry),
        pid,
    }
}

pub(crate) fn stop_starting_processes(registry: &StartingProcessRegistry) {
    let pids = registry
        .lock()
        .map(|pids| pids.iter().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    for pid in pids {
        stop_process_tree(pid);
    }
}

pub(crate) fn starting_processes_empty(registry: &StartingProcessRegistry) -> bool {
    registry.lock().map(|pids| pids.is_empty()).unwrap_or(true)
}

/// Stop a managed child and all descendants. Runtime and Gateway are Node
/// processes, so killing only `Child` can leave worker processes behind.
pub(crate) fn stop_child_tree(child: &mut Child) {
    let pid = child.id();
    stop_process_tree(pid);
    // Always retain the direct-child fallback. It also reaps the child on
    // platforms where the tree command is unavailable or already raced exit.
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn stop_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        super::platform::configure_child_command(&mut command);
        let _ = command.status();
    }

    #[cfg(unix)]
    {
        // configure_child_command places managed Node processes in their own
        // process group. Signal the group so Node workers and spawned helpers
        // leave with the host process.
        let group = format!("-{pid}");
        let term = Command::new("kill").args(["-TERM", &group]).status();
        if term.map(|status| !status.success()).unwrap_or(true) {
            let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
        }
        thread::sleep(Duration::from_millis(120));
        let force = Command::new("kill").args(["-KILL", &group]).status();
        if force.map(|status| !status.success()).unwrap_or(true) {
            let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
        }
    }
}
