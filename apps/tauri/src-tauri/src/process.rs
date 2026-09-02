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

impl StartingProcessGuard {
    /// Remove the PID at the exact point where the caller publishes the child
    /// into its managed Runtime/Gateway state. Until then shutdown treats it
    /// as an in-flight child and cannot miss the short publication window.
    pub(crate) fn complete(&self) {
        if let Ok(mut pids) = self.registry.lock() {
            pids.remove(&self.pid);
        }
    }
}

impl Drop for StartingProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut pids) = self.registry.lock() {
            pids.remove(&self.pid);
        }
    }
}

/// Spawn a child while holding the registry lock across the OS spawn call.
///
/// Registering a PID in a second step leaves a small but real shutdown race:
/// an exit request could observe an empty registry after `spawn()` returned and
/// before the PID was inserted. Holding the lock makes shutdown wait for the
/// PID publication, after which the cleanup pass can terminate it reliably.
pub(crate) fn spawn_registered(
    command: &mut Command,
    registry: &StartingProcessRegistry,
    quitting: &std::sync::atomic::AtomicBool,
) -> Result<(Child, StartingProcessGuard), String> {
    let mut pids = registry
        .lock()
        .map_err(|_| "启动进程注册表已损坏。".to_string())?;
    if quitting.load(std::sync::atomic::Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝启动后台进程。".into());
    }
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动受管后台进程: {error}"))?;
    let pid = child.id();
    pids.insert(pid);
    drop(pids);
    Ok((
        child,
        StartingProcessGuard {
            registry: Arc::clone(registry),
            pid,
        },
    ))
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
