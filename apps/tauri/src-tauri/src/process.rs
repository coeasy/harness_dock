use std::{
    collections::HashSet,
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

pub(crate) type StartingProcessRegistry = Arc<Mutex<HashSet<u32>>>;

pub(crate) struct StartingProcessGuard {
    registry: StartingProcessRegistry,
    pid: u32,
    #[cfg(windows)]
    job: Option<windows_job::JobHandle>,
}

impl StartingProcessGuard {
    pub(crate) fn complete(&self) {
        if let Ok(mut pids) = self.registry.lock() {
            pids.remove(&self.pid);
        }
    }

    pub(crate) fn terminate_tree(&self) {
        #[cfg(windows)]
        if let Some(job) = self.job.as_ref() {
            job.terminate();
            return;
        }
        stop_process_tree(self.pid);
    }
}

impl Drop for StartingProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut pids) = self.registry.lock() {
            pids.remove(&self.pid);
        }
        // On Windows the Job Object is configured with KILL_ON_JOB_CLOSE. Its
        // handle is intentionally held by the resource owner for the full
        // lifetime of the child, so dropping the owner is the final no-orphan
        // cleanup even if ordinary termination raced or failed.
    }
}

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
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动受管后台进程: {error}"))?;
    let pid = child.id();

    #[cfg(windows)]
    let job = match windows_job::JobHandle::assign(&child) {
        Ok(job) => Some(job),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法把受管进程加入 Windows Job Object: {error}"));
        }
    };

    pids.insert(pid);
    drop(pids);
    Ok((
        child,
        StartingProcessGuard {
            registry: Arc::clone(registry),
            pid,
            #[cfg(windows)]
            job,
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

pub(crate) fn stop_child_tree(child: &mut Child) {
    let pid = child.id();
    stop_process_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn stop_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        // StartingProcessGuard's Job Object is the primary lifecycle boundary.
        // taskkill is retained only as a diagnostic/repair fallback for a PID
        // observed before its resource owner has been published.
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        super::platform::configure_child_command(&mut command);
        let _ = command.status();
    }

    #[cfg(unix)]
    {
        // platform::configure_child_command gives each managed child its own
        // process group. TERM the group, allow a short grace period, then KILL.
        let group = format!("-{pid}");
        let term = Command::new("kill").args(["-TERM", &group]).status();
        if term.map(|status| !status.success()).unwrap_or(true) {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        thread::sleep(Duration::from_millis(350));
        let force = Command::new("kill").args(["-KILL", &group]).status();
        if force.map(|status| !status.success()).unwrap_or(true) {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, process::Child, ptr};

    type Handle = *mut c_void;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *const c_void,
            info_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(crate) struct JobHandle(Handle);

    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        pub(crate) fn assign(child: &Child) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
                if job.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut limits: ExtendedLimitInformation = std::mem::zeroed();
                limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    &limits as *const _ as *const c_void,
                    size_of::<ExtendedLimitInformation>() as u32,
                ) == 0
                {
                    let error = std::io::Error::last_os_error().to_string();
                    CloseHandle(job);
                    return Err(error);
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as Handle) == 0 {
                    let error = std::io::Error::last_os_error().to_string();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self(job))
            }
        }

        pub(crate) fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
