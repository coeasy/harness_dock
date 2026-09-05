//! Runtime types shared by every runtime submodule.
//!
//! Deliberately free of business logic so `runtime_actor` can depend on the
//! `RuntimeProcess` handle without pulling in spawn/launch code (invariant 3).


// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub app_url: Option<String>,
    pub dsh_version: Option<String>,
    pub pid: Option<u32>,
    pub generation: Option<u64>,
    pub image_identity: Option<String>,
    pub recovery_mode: bool,
    pub recovery_source: String,
    pub isolated_plugins: Vec<String>,
    pub suspected_plugins: Vec<String>,
    pub quarantine_expires_at: Option<u64>,
    pub safe_mode: bool,
    pub node_source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub pid: u32,
    pub dsh_version: String,
    pub generation: u64,
    pub nonce: String,
    pub image_identity: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginInfo {
    pub dsh_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub image_identity: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeImage {
    pub root: PathBuf,
    pub node: PathBuf,
    pub dsh: PathBuf,
    pub origin: OriginInfo,
    pub image_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDumpRow {
    pub id: String,
    pub name: Option<String>,
    pub source: String,
}

#[derive(Debug)]
pub struct AttemptFailure {
    pub message: String,
    pub diagnostic: String,
}

pub(crate) struct RuntimeProcess {
    pub child: Child,
    pub stopped: bool,
    pub(crate) registration: process_control::StartingProcessGuard,
    pub work_dir: PathBuf,
    pub ready: ReadyInfo,
    pub recovery_source: String,
    pub isolated_plugins: Vec<String>,
    pub suspected_plugins: Vec<String>,
    pub quarantine_expires_at: Option<u64>,
    pub safe_mode: bool,
}

impl RuntimeProcess {
    pub fn status(&self, lease: Option<&RuntimeLease>) -> RuntimeStatus {
        RuntimeStatus {
            state: if self.safe_mode || !self.isolated_plugins.is_empty() {
                "degraded".into()
            } else {
                "ready".into()
            },
            app_url: Some(self.ready.url.clone()),
            dsh_version: Some(self.ready.dsh_version.clone()),
            pid: Some(self.ready.pid),
            generation: lease.map(|lease| lease.generation.id),
            image_identity: lease.map(|lease| lease.generation.image_identity.clone()),
            recovery_mode: self.safe_mode || !self.isolated_plugins.is_empty(),
            recovery_source: self.recovery_source.clone(),
            isolated_plugins: self.isolated_plugins.clone(),
            suspected_plugins: self.suspected_plugins.clone(),
            quarantine_expires_at: self.quarantine_expires_at,
            safe_mode: self.safe_mode,
            node_source: "bundled".into(),
        }
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        // Pure liveness probe. Discovered exit statuses are applied only by
        // the explicit reaper path (`RuntimeActor::reap_if_dead`); a read-only
        // status snapshot must never mutate `stopped` or revoke a live lease.
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(error) => {
                // A failed liveness inspection is not evidence that the child
                // exited. Revoking the published RuntimeLease on an inspection
                // error races WebView page-load callbacks and can tear down a
                // healthy packaged Runtime. Preserve the lease until an actual
                // exit status is observed or an explicit stop/restart occurs.
                eprintln!(
                    "Unable to inspect dsh Runtime process; preserving current RuntimeLease: {error}"
                );
                true
            }
        }
    }

    pub(crate) fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            self.registration.terminate_tree();
            process_control::stop_child_tree(&mut self.child);
        }
        let _ = fs::remove_dir_all(&self.work_dir);
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn phase_status(phase: RuntimePhase, generation: Option<u64>) -> RuntimeStatus {
    RuntimeStatus {
        state: match phase {
            RuntimePhase::Stopped => "stopped",
            RuntimePhase::Preparing => "preparing",
            RuntimePhase::Starting => "starting",
            RuntimePhase::Probing => "probing",
            RuntimePhase::Ready => "ready",
            RuntimePhase::Degraded => "degraded",
            RuntimePhase::Stopping => "stopping",
            RuntimePhase::Cancelling => "cancelling",
            RuntimePhase::Failed => "failed",
        }
        .into(),
        app_url: None,
        dsh_version: None,
        pid: None,
        generation,
        image_identity: None,
        recovery_mode: false,
        recovery_source: "none".into(),
        isolated_plugins: Vec::new(),
        suspected_plugins: Vec::new(),
        quarantine_expires_at: None,
        safe_mode: false,
        node_source: "bundled".into(),
    }
}
