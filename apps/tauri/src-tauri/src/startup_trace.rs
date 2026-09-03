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
    RuntimeStart = 1,
    RuntimeReady = 2,
    WebviewRequested = 3,
    Recovery = 4,
}

impl StartupPhase {
    fn name(self) -> &'static str {
        match self {
            Self::ProcessStarted => "process_started",
            Self::RuntimeStart => "runtime_start",
            Self::RuntimeReady => "runtime_ready",
            Self::WebviewRequested => "webview_requested",
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
/// Each phase is written at most once and any filesystem failure is ignored so
/// observability can never become a startup dependency.
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
    fn phase_names_are_stable_and_secret_free() {
        for phase in [
            StartupPhase::ProcessStarted,
            StartupPhase::RuntimeStart,
            StartupPhase::RuntimeReady,
            StartupPhase::WebviewRequested,
            StartupPhase::Recovery,
        ] {
            let name = phase.name();
            assert!(!name.contains("token"));
            assert!(!name.contains("url"));
            assert!(!name.contains("secret"));
        }
    }
}
