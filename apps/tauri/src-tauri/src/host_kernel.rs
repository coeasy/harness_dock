use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::{HashMap, VecDeque},
    sync::{mpsc::SyncSender, Arc, Mutex},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::{
    host_protocol::{
        CommandEnvelope, ErrorScope, HostCommand, HostError, HostEvent, HostEventKind,
        HostResponse, ResponseEnvelope, SubjectKind, HOST_PROTOCOL_VERSION,
    },
    AppState,
};

const KERNEL_QUEUE_CAPACITY: usize = 128;
const DEDUPE_WINDOW: usize = 256;
static NATIVE_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Default)]
pub(crate) struct KernelPublicState {
    pub(crate) event_sequence: u64,
    pub(crate) revision: u64,
}

struct KernelRequest {
    envelope: CommandEnvelope,
    reply: SyncSender<ResponseEnvelope>,
}

#[derive(Clone)]
pub(crate) struct HostKernelHandle {
    sender: tauri::async_runtime::Sender<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
}

impl HostKernelHandle {
    pub(crate) async fn execute(&self, envelope: CommandEnvelope) -> ResponseEnvelope {
        let request_id = envelope.request_id.clone();
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        if self
            .sender
            .send(KernelRequest {
                envelope,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            return protocol_failure(
                request_id,
                "HOST_KERNEL_UNAVAILABLE",
                "Host Kernel command queue is unavailable",
                true,
            );
        }
        match tauri::async_runtime::spawn_blocking(move || reply_rx.recv()).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => protocol_failure(
                request_id,
                "HOST_KERNEL_REPLY_CLOSED",
                "Host Kernel closed the command reply channel",
                true,
            ),
            Err(error) => protocol_failure(
                request_id,
                "HOST_KERNEL_REPLY_FAILED",
                format!("Host Kernel reply task failed: {error}"),
                true,
            ),
        }
    }

    pub(crate) fn public_state(&self) -> KernelPublicState {
        self.public
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }
}

fn protocol_failure(
    request_id: String,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> ResponseEnvelope {
    ResponseEnvelope {
        protocol_version: HOST_PROTOCOL_VERSION,
        request_id,
        result: Err(HostError::new(code, ErrorScope::Host, message, retryable)),
    }
}

fn command_fingerprint(envelope: &CommandEnvelope) -> String {
    serde_json::to_string(&(envelope.subject, &envelope.command))
        .unwrap_or_else(|_| format!("{:?}:{:?}", envelope.subject, envelope.command))
}

fn current_revision(app: &AppHandle) -> u64 {
    app.state::<AppState>().revision.load(Ordering::Acquire)
}

fn record_event(
    app: &AppHandle,
    public: &Arc<Mutex<KernelPublicState>>,
    request_id: &str,
    operation_id: String,
    kind: HostEventKind,
) {
    let revision = current_revision(app);
    let event = {
        let Ok(mut state) = public.lock() else { return };
        state.event_sequence = state.event_sequence.saturating_add(1);
        state.revision = revision;
        HostEvent {
            protocol_version: HOST_PROTOCOL_VERSION,
            sequence: state.event_sequence,
            revision,
            operation_id,
            request_id: request_id.to_string(),
            kind,
        }
    };
    let _ = app.emit("harnessdock://host-event", event);
}

async fn kernel_loop(
    app: AppHandle,
    mut receiver: tauri::async_runtime::Receiver<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
) {
    let mut dedupe: HashMap<String, (String, ResponseEnvelope)> = HashMap::new();
    let mut dedupe_order = VecDeque::new();
    let mut operation_sequence = 0_u64;

    while let Some(request) = receiver.recv().await {
        let request_id = request.envelope.request_id.clone();
        let fingerprint = command_fingerprint(&request.envelope);
        if let Some((previous_fingerprint, previous_response)) = dedupe.get(&request_id) {
            let response = if previous_fingerprint == &fingerprint {
                previous_response.clone()
            } else {
                protocol_failure(
                    request_id.clone(),
                    "REQUEST_ID_REUSED",
                    "requestId was reused for a different Host command",
                    false,
                )
            };
            let _ = request.reply.send(response);
            continue;
        }

        operation_sequence = operation_sequence.saturating_add(1);
        let operation_id = format!("host-op-{operation_sequence}");
        let result = crate::reconciler::execute(
            app.clone(),
            request.envelope.subject,
            request.envelope.command.clone(),
        )
        .await
        .map(|_| HostResponse::Ack);
        let event_kind = match &result {
            Ok(_) => HostEventKind::CommandSucceeded,
            Err(_) => HostEventKind::CommandFailed,
        };
        let response = ResponseEnvelope {
            protocol_version: HOST_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            result,
        };
        record_event(&app, &public, &request_id, operation_id, event_kind);

        dedupe.insert(request_id.clone(), (fingerprint, response.clone()));
        dedupe_order.push_back(request_id);
        while dedupe_order.len() > DEDUPE_WINDOW {
            if let Some(expired) = dedupe_order.pop_front() {
                dedupe.remove(&expired);
            }
        }
        let _ = request.reply.send(response);
    }
}

pub(crate) fn install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut slot = state
        .host_kernel
        .lock()
        .map_err(|_| "Host Kernel state lock is poisoned".to_string())?;
    if slot.is_some() {
        return Ok(());
    }
    let (sender, receiver) = tauri::async_runtime::channel(KERNEL_QUEUE_CAPACITY);
    let public = Arc::new(Mutex::new(KernelPublicState::default()));
    *slot = Some(HostKernelHandle {
        sender,
        public: Arc::clone(&public),
    });
    drop(slot);
    tauri::async_runtime::spawn(kernel_loop(app, receiver, public));
    Ok(())
}

pub(crate) async fn execute_envelope(
    app: &AppHandle,
    envelope: CommandEnvelope,
) -> ResponseEnvelope {
    let request_id = envelope.request_id.clone();
    let handle = app
        .state::<AppState>()
        .host_kernel
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    match handle {
        Some(handle) => handle.execute(envelope).await,
        None => protocol_failure(
            request_id,
            "HOST_KERNEL_NOT_INITIALIZED",
            "Host Kernel has not been initialized",
            true,
        ),
    }
}

pub(crate) async fn execute_native(
    app: AppHandle,
    subject: SubjectKind,
    command: HostCommand,
) -> Result<(), HostError> {
    let sequence = NATIVE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let envelope = CommandEnvelope {
        protocol_version: HOST_PROTOCOL_VERSION,
        request_id: format!("native-{sequence}"),
        subject,
        command,
    };
    execute_envelope(&app, envelope).await.result.map(|_| ())
}

pub(crate) fn public_state(app: &AppHandle) -> KernelPublicState {
    app.state::<AppState>()
        .host_kernel
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .map(|handle| handle.public_state())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_request_ids_are_monotonic() {
        let first = NATIVE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let second = NATIVE_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        assert!(second > first);
    }

    #[test]
    fn protocol_failure_preserves_request_id() {
        let response = protocol_failure("req-1".into(), "TEST", "test", false);
        assert_eq!(response.request_id, "req-1");
        assert!(response.result.is_err());
    }
}
