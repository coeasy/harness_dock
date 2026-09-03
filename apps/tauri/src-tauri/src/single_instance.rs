use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerRecord {
    pid: u32,
    port: u16,
    nonce: String,
}

pub(crate) enum InstallOutcome {
    Primary(SingleInstanceGuard),
    SecondaryHandedOff,
}

pub(crate) struct SingleInstanceGuard {
    stop: Arc<AtomicBool>,
    port: u16,
    record_path: PathBuf,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(
            &(std::net::Ipv4Addr::LOCALHOST, self.port).into(),
            Duration::from_millis(100),
        );
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        let _ = fs::remove_file(&self.record_path);
    }
}

fn record_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("single-instance-v1.json"))
        .map_err(|error| format!("无法解析 single-instance 目录: {error}"))
}

fn random_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    secure_random(&mut bytes)?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}

#[cfg(unix)]
fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buffer))
        .map_err(|error| format!("OS random source unavailable for single-instance nonce: {error}"))
}

#[cfg(windows)]
fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut u8, length: u32) -> u8;
    }
    let length = u32::try_from(buffer.len()).map_err(|_| "single-instance nonce too large".to_string())?;
    if unsafe { rtl_gen_random(buffer.as_mut_ptr(), length) } == 0 {
        Err("Windows random source unavailable for single-instance nonce".into())
    } else {
        Ok(())
    }
}

fn try_handoff(path: &PathBuf) -> bool {
    let Ok(raw) = fs::read_to_string(path) else { return false };
    let Ok(record) = serde_json::from_str::<OwnerRecord>(&raw) else { return false };
    let addr = (std::net::Ipv4Addr::LOCALHOST, record.port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    stream
        .write_all(format!("FOCUS {}\n", record.nonce).as_bytes())
        .is_ok()
}

fn dispatch_primary_activation(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::host_kernel::execute_native(
            app.clone(),
            crate::host_protocol::SubjectKind::DesktopShell,
            crate::host_protocol::HostCommand::ActivatePrimary,
        )
        .await
        {
            crate::desktop::report_shell_error(&app, &error.message);
        }
    });
}

fn install_primary(app: AppHandle, path: PathBuf) -> Result<SingleInstanceGuard, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut owner = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("无法创建 single-instance listener: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let nonce = random_nonce()?;
    let record = OwnerRecord {
        pid: std::process::id(),
        port,
        nonce: nonce.clone(),
    };
    owner
        .write_all(serde_json::to_string(&record).map_err(|error| error.to_string())?.as_bytes())
        .and_then(|_| owner.sync_all())
        .map_err(|error| format!("无法写入 single-instance owner record: {error}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = thread::Builder::new()
        .name("harnessdock-single-instance".into())
        .spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut raw = String::new();
                        let _ = stream.read_to_string(&mut raw);
                        if raw.trim() == format!("FOCUS {nonce}") {
                            dispatch_primary_activation(app.clone());
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(120)),
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(SingleInstanceGuard {
        stop,
        port,
        record_path: path,
        thread: Some(handle),
    })
}

pub(crate) fn install(app: AppHandle) -> Result<InstallOutcome, String> {
    let path = record_path(&app)?;
    match install_primary(app.clone(), path.clone()) {
        Ok(guard) => Ok(InstallOutcome::Primary(guard)),
        Err(_) if try_handoff(&path) => Ok(InstallOutcome::SecondaryHandedOff),
        Err(_) => {
            // Transitional fallback until the official Tauri single-instance
            // plugin fully owns this boundary. Even this path only emits a
            // typed Host intent; it never manipulates Runtime or windows.
            let _ = fs::remove_file(&path);
            install_primary(app, path).map(InstallOutcome::Primary)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_record_never_contains_runtime_credentials() {
        let record = OwnerRecord { pid: 1, port: 12345, nonce: "abc".into() };
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("token"));
        assert!(!json.contains("url"));
    }
}
