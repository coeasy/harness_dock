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
const KERNEL_FAST_QUEUE_CAPACITY: usize = 64;
const DEDUPE_WINDOW: usize = 256;
static NATIVE_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Fast commands finish in the low tens of milliseconds (window management,
/// reload, opening an on-demand surface). Slow commands own process/update
/// lifecycles (restart, safe-mode, install, quit) and can take seconds.
///
/// The host kernel keeps two queues so a slow command cannot starve the
/// window/reload surface. The queues are consumed concurrently, while request
/// admission and dedupe remain serialized through `SharedKernelState`.
fn is_fast_command(command: &HostCommand) -> bool {
    matches!(
        command,
        HostCommand::ActivatePrimary
            | HostCommand::RefreshHarness
            | HostCommand::ShowGateway
            | HostCommand::ShowDiagnostics
    )
}

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
    fast_sender: tauri::async_runtime::Sender<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
}

impl HostKernelHandle {
    pub(crate) async fn execute(&self, envelope: CommandEnvelope) -> ResponseEnvelope {
        let request_id = envelope.request_id.clone();
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        let target = if is_fast_command(&envelope.command) {
            &self.fast_sender
        } else {
            &self.sender
        };
        if target
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
) -> Result<(), String> {
    let revision = current_revision(app);
    let event = {
        let mut state = public
            .lock()
            .map_err(|_| "Host Kernel public-state mutex is poisoned".to_string())?;
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
    // Failing to publish a Host event is not fatal to the command itself, but
    // it must not be silent: a frontend that never receives CommandSucceeded/
    // CommandFailed cannot resync. Surface the failure in the startup trace
    // log so event loss is observable instead of swallowed.
    app.emit("harnessdock://host-event", event)
        .map_err(|error| format!("failed to publish host event: {error}"))
}

#[derive(Default)]
struct InFlightKernelRequest {
    fingerprint: String,
    waiters: Vec<SyncSender<ResponseEnvelope>>,
}

/// Shared command-dedupe state used by both the fast and slow kernel
/// consumers. Fast/slow consumers run concurrently, so admission must reserve
/// a request id before the reconciler is awaited. Otherwise the same request
/// can enter both queues before either result is cached and execute twice.
#[derive(Default)]
struct SharedKernelState {
    dedupe: HashMap<String, (String, ResponseEnvelope)>,
    dedupe_order: VecDeque<String>,
    inflight: HashMap<String, InFlightKernelRequest>,
    operation_sequence: u64,
}

fn admit_kernel_request(
    state: &mut SharedKernelState,
    request: &KernelRequest,
    fingerprint: &str,
) -> Option<String> {
    let request_id = &request.envelope.request_id;

    if let Some((previous_fingerprint, previous_response)) = state.dedupe.get(request_id) {
        let response = if previous_fingerprint == fingerprint {
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
        return None;
    }

    if let Some(active) = state.inflight.get_mut(request_id) {
        if active.fingerprint == fingerprint {
            active.waiters.push(request.reply.clone());
        } else {
            let _ = request.reply.send(protocol_failure(
                request_id.clone(),
                "REQUEST_ID_REUSED",
                "requestId was reused for a different in-flight Host command",
                false,
            ));
        }
        return None;
    }

    state.operation_sequence = state.operation_sequence.saturating_add(1);
    let operation_id = format!("host-op-{}", state.operation_sequence);
    state.inflight.insert(
        request_id.clone(),
        InFlightKernelRequest {
            fingerprint: fingerprint.to_string(),
            waiters: Vec::new(),
        },
    );
    Some(operation_id)
}

fn complete_kernel_request(
    state: &mut SharedKernelState,
    request_id: &str,
    fingerprint: String,
    response: ResponseEnvelope,
) -> Vec<SyncSender<ResponseEnvelope>> {
    let waiters = state
        .inflight
        .remove(request_id)
        .map(|active| active.waiters)
        .unwrap_or_default();

    state
        .dedupe
        .insert(request_id.to_string(), (fingerprint, response));
    state.dedupe_order.push_back(request_id.to_string());
    while state.dedupe_order.len() > DEDUPE_WINDOW {
        if let Some(expired) = state.dedupe_order.pop_front() {
            state.dedupe.remove(&expired);
        }
    }
    waiters
}

#[allow(clippy::too_many_arguments)]
async fn process_kernel_request(
    app: &AppHandle,
    public: &Arc<Mutex<KernelPublicState>>,
    shared: &Arc<Mutex<SharedKernelState>>,
    request: KernelRequest,
) {
    let request_id = request.envelope.request_id.clone();
    let fingerprint = command_fingerprint(&request.envelope);

    // Phase 1 (synchronous, lock scoped to this block): completed-request
    // dedupe, in-flight reservation and operation-id allocation. std
    // MutexGuards are not Send, so no guard may live across phase 2.
    let operation_id = {
        let mut state = match shared.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        match admit_kernel_request(&mut state, &request, &fingerprint) {
            Some(operation_id) => operation_id,
            None => return,
        }
    };

    // Phase 2 (await, no kernel lock held): reconcile the command.
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
    if let Err(error) = record_event(app, public, &request_id, operation_id, event_kind) {
        eprintln!("host kernel event publication failed (observable, not silent): {error}");
    }

    // Phase 3 (synchronous, lock scoped to this block): atomically retire the
    // in-flight reservation and cache the completed response. Duplicate
    // callers that arrived while phase 2 was running are released afterwards
    // with the exact same response.
    let waiters = {
        let mut state = match shared.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        complete_kernel_request(&mut state, &request_id, fingerprint, response.clone())
    };

    let _ = request.reply.send(response.clone());
    for waiter in waiters {
        let _ = waiter.send(response.clone());
    }
}

/// The slow consumer owns the main command queue (restart, safe-mode,
/// install-update, quit). The fast consumer drains the fast queue
/// (window/reload/diagnostics) in a separate task, so a long-running slow
/// command can no longer block surface commands.
async fn kernel_slow_loop(
    app: AppHandle,
    mut receiver: tauri::async_runtime::Receiver<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
    shared: Arc<Mutex<SharedKernelState>>,
) {
    while let Some(request) = receiver.recv().await {
        process_kernel_request(&app, &public, &shared, request).await;
    }
}

async fn kernel_fast_loop(
    app: AppHandle,
    mut fast_receiver: tauri::async_runtime::Receiver<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
    shared: Arc<Mutex<SharedKernelState>>,
) {
    while let Some(request) = fast_receiver.recv().await {
        process_kernel_request(&app, &public, &shared, request).await;
    }
}

async fn kernel_loop(
    app: AppHandle,
    receiver: tauri::async_runtime::Receiver<KernelRequest>,
    fast_receiver: tauri::async_runtime::Receiver<KernelRequest>,
    public: Arc<Mutex<KernelPublicState>>,
) {
    let shared = Arc::new(Mutex::new(SharedKernelState::default()));
    let fast_app = app.clone();
    let tasks = vec![
        tauri::async_runtime::spawn(kernel_slow_loop(
            app,
            receiver,
            Arc::clone(&public),
            Arc::clone(&shared),
        )),
        tauri::async_runtime::spawn(kernel_fast_loop(
            fast_app,
            fast_receiver,
            Arc::clone(&public),
            Arc::clone(&shared),
        )),
    ];
    for task in tasks {
        let _ = task.await;
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
    let (fast_sender, fast_receiver) = tauri::async_runtime::channel(KERNEL_FAST_QUEUE_CAPACITY);
    let public = Arc::new(Mutex::new(KernelPublicState::default()));
    *slot = Some(HostKernelHandle {
        sender,
        fast_sender,
        public: Arc::clone(&public),
    });
    drop(slot);
    tauri::async_runtime::spawn(kernel_loop(app, receiver, fast_receiver, public));
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

    fn request(
        request_id: &str,
        command: HostCommand,
    ) -> (KernelRequest, std::sync::mpsc::Receiver<ResponseEnvelope>) {
        let (reply, receiver) = std::sync::mpsc::sync_channel(1);
        (
            KernelRequest {
                envelope: CommandEnvelope {
                    protocol_version: HOST_PROTOCOL_VERSION,
                    request_id: request_id.to_string(),
                    subject: SubjectKind::NativeMenu,
                    command,
                },
                reply,
            },
            receiver,
        )
    }

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

    #[test]
    fn duplicate_inflight_request_waits_for_the_first_response() {
        let mut state = SharedKernelState::default();
        let (first, _first_rx) = request("req-1", HostCommand::RefreshHarness);
        let fingerprint = command_fingerprint(&first.envelope);
        assert_eq!(
            admit_kernel_request(&mut state, &first, &fingerprint).as_deref(),
            Some("host-op-1")
        );

        let (duplicate, duplicate_rx) = request("req-1", HostCommand::RefreshHarness);
        assert!(admit_kernel_request(&mut state, &duplicate, &fingerprint).is_none());
        assert_eq!(state.inflight["req-1"].waiters.len(), 1);

        let response = ResponseEnvelope {
            protocol_version: HOST_PROTOCOL_VERSION,
            request_id: "req-1".into(),
            result: Ok(HostResponse::Ack),
        };
        let waiters = complete_kernel_request(&mut state, "req-1", fingerprint, response.clone());
        for waiter in waiters {
            let _ = waiter.send(response.clone());
        }
        let duplicate_response = duplicate_rx.recv().expect("duplicate response");
        assert_eq!(duplicate_response.request_id, "req-1");
        assert!(duplicate_response.result.is_ok());
        assert!(!state.inflight.contains_key("req-1"));
    }

    #[test]
    fn conflicting_inflight_request_id_fails_closed() {
        let mut state = SharedKernelState::default();
        let (first, _first_rx) = request("req-2", HostCommand::RefreshHarness);
        let first_fingerprint = command_fingerprint(&first.envelope);
        assert!(admit_kernel_request(&mut state, &first, &first_fingerprint).is_some());

        let (conflict, conflict_rx) = request("req-2", HostCommand::RestartRuntime);
        let conflict_fingerprint = command_fingerprint(&conflict.envelope);
        assert!(admit_kernel_request(&mut state, &conflict, &conflict_fingerprint).is_none());
        let response = conflict_rx.recv().expect("conflict response");
        let error = response
            .result
            .expect_err("conflicting request id must fail");
        assert_eq!(error.code, "REQUEST_ID_REUSED");
        assert_eq!(state.inflight.len(), 1);
    }
}
