use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

static STARTED_AT: OnceLock<Instant> = OnceLock::new();
static TRACE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static WRITTEN_PHASES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
pub(crate) enum StartupPhase {
    ProcessStarted = 0,
    RuntimeVerified = 1,
    RuntimeSpawned = 2,
    RuntimeReady = 3,
    WebviewRequested = 4,
    PrimaryVisible = 5,
    ShellReady = 6,
    NativeFallback = 7,
    Recovery = 8,
}

impl StartupPhase {
    fn name(self) -> &'static str {
        match self {
            Self::ProcessStarted => "process_started",
            Self::RuntimeVerified => "runtime_verified",
            Self::RuntimeSpawned => "runtime_spawned",
            Self::RuntimeReady => "runtime_ready",
            Self::WebviewRequested => "webview_requested",
            Self::PrimaryVisible => "primary_visible",
            Self::ShellReady => "shell_ready",
            Self::NativeFallback => "native_fallback",
            Self::Recovery => "recovery",
        }
    }
}

fn trace_dir() -> PathBuf {
    std::env::temp_dir().join("harnessdock-logs")
}

fn ensure_trace_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn prune_old_traces(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut traces = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if !name.starts_with("startup-") || !name.ends_with(".log") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    traces.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in traces.into_iter().skip(20) {
        let _ = fs::remove_file(path);
    }
}

fn resolved_trace_path() -> Option<&'static PathBuf> {
    TRACE_PATH
        .get_or_init(|| {
            let dir = trace_dir();
            if ensure_trace_dir(&dir).is_err() {
                return None;
            }
            prune_old_traces(&dir);
            Some(dir.join(format!("startup-{}.log", std::process::id())))
        })
        .as_ref()
}

/// Best-effort startup telemetry with no URLs, tokens, diagnostics or user data.
/// This is also the executable Round-5 startup SLO contract.
pub(crate) fn mark(phase: StartupPhase) {
    let bit = 1_u64 << phase as u64;
    if WRITTEN_PHASES.fetch_or(bit, Ordering::AcqRel) & bit != 0 {
        return;
    }
    let started = STARTED_AT.get_or_init(Instant::now);
    let elapsed_ms = started.elapsed().as_millis();
    let Some(path) = resolved_trace_path() else {
        return;
    };
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "[+{elapsed_ms}ms] phase={}", phase.name());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_five_phase_names_are_stable_and_secret_free() {
        let phases = [
            StartupPhase::ProcessStarted,
            StartupPhase::RuntimeVerified,
            StartupPhase::RuntimeSpawned,
            StartupPhase::RuntimeReady,
            StartupPhase::WebviewRequested,
            StartupPhase::PrimaryVisible,
            StartupPhase::ShellReady,
            StartupPhase::NativeFallback,
            StartupPhase::Recovery,
        ];
        for phase in phases {
            let name = phase.name();
            assert!(!name.contains("token"));
            assert!(!name.contains("url"));
            assert!(!name.contains("secret"));
        }
    }
}
