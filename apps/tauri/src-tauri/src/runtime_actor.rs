use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crate::runtime::types::RuntimeProcess;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimePhase {
    Stopped,
    Preparing,
    Starting,
    Probing,
    Ready,
    Degraded,
    Stopping,
    Cancelling,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    Normal,
    Safe,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGeneration {
    pub id: u64,
    pub nonce: String,
    pub image_identity: String,
    pub mode: RuntimeMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLease {
    pub generation: RuntimeGeneration,
    pub pid: u32,
    pub origin: String,
    pub launch_url: String,
    pub dsh_version: String,
}

#[derive(Clone)]
pub(crate) struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeActorState {
    phase: RuntimePhase,
    generation: Option<RuntimeGeneration>,
    desired_generation: u64,
    last_error: Option<String>,
}

impl Default for RuntimeActorState {
    fn default() -> Self {
        Self {
            phase: RuntimePhase::Stopped,
            generation: None,
            desired_generation: 0,
            last_error: None,
        }
    }
}

impl RuntimeActorState {
    pub(crate) fn phase(&self) -> RuntimePhase {
        self.phase
    }

    pub(crate) fn generation(&self) -> Option<&RuntimeGeneration> {
        self.generation.as_ref()
    }

    pub(crate) fn desired_generation(&self) -> u64 {
        self.desired_generation
    }

    pub(crate) fn is_transitioning(&self) -> bool {
        matches!(
            self.phase,
            RuntimePhase::Preparing
                | RuntimePhase::Starting
                | RuntimePhase::Probing
                | RuntimePhase::Stopping
                | RuntimePhase::Cancelling
        )
    }

    fn begin(&mut self, mode: RuntimeMode) -> Result<RuntimeGeneration, String> {
        // The nonce is part of the Runtime ready-file trust boundary. It must be
        // unpredictable; PID/time hashing is not sufficient because another
        // local process could pre-create a plausible stale ready file.
        let nonce = generation_nonce()?;
        self.desired_generation = self.desired_generation.saturating_add(1);
        let id = self.desired_generation;
        let generation = RuntimeGeneration {
            id,
            nonce,
            image_identity: "unverified".into(),
            mode,
        };
        self.phase = RuntimePhase::Preparing;
        self.generation = Some(generation.clone());
        self.last_error = None;
        Ok(generation)
    }

    fn bind_image(&mut self, generation: u64, image_identity: String) -> Result<(), String> {
        let Some(current) = self.generation.as_mut() else {
            return Err("Runtime generation disappeared before image verification".into());
        };
        if current.id != generation || self.phase != RuntimePhase::Preparing {
            return Err("stale Runtime image verification result".into());
        }
        current.image_identity = image_identity;
        Ok(())
    }

    fn mark_starting(&mut self, generation: u64) -> Result<(), String> {
        self.transition(generation, RuntimePhase::Preparing, RuntimePhase::Starting)
    }

    fn mark_probing(&mut self, generation: u64) -> Result<(), String> {
        if !matches!(self.phase, RuntimePhase::Starting | RuntimePhase::Preparing) {
            return Err("Runtime can probe only after prepare/start".into());
        }
        self.ensure_generation(generation)?;
        self.phase = RuntimePhase::Probing;
        Ok(())
    }

    fn mark_ready(&mut self, generation: u64, degraded: bool) -> Result<(), String> {
        if !matches!(
            self.phase,
            RuntimePhase::Preparing | RuntimePhase::Starting | RuntimePhase::Probing
        ) {
            return Err("stale Runtime ready result".into());
        }
        self.ensure_generation(generation)?;
        self.phase = if degraded {
            RuntimePhase::Degraded
        } else {
            RuntimePhase::Ready
        };
        Ok(())
    }

    fn accept_ready_generation(
        &mut self,
        generation: u64,
        lease_generation: &RuntimeGeneration,
        degraded: bool,
    ) -> Result<(), String> {
        let Some(current) = self.generation.as_ref() else {
            return Err("Runtime generation disappeared before ready publish".into());
        };
        // RuntimeLease is a trust boundary, not just a sequence number. A
        // matching id with a stale nonce, image identity or mode must never
        // transition the actor to Ready. Validate the complete immutable
        // generation before mutating phase so rejected publications are
        // side-effect free.
        if current.id != generation || current != lease_generation {
            return Err("stale Runtime ready generation binding".into());
        }
        self.mark_ready(generation, degraded)
    }

    fn mark_failed(&mut self, generation: u64, message: String) {
        if self
            .generation
            .as_ref()
            .is_some_and(|current| current.id == generation)
        {
            self.phase = RuntimePhase::Failed;
            self.last_error = Some(message);
        }
    }

    fn begin_stop(&mut self) {
        self.phase = if matches!(
            self.phase,
            RuntimePhase::Preparing | RuntimePhase::Starting | RuntimePhase::Probing
        ) {
            RuntimePhase::Cancelling
        } else if self.phase == RuntimePhase::Stopped {
            RuntimePhase::Stopped
        } else {
            RuntimePhase::Stopping
        };
    }

    fn settle_stopped(&mut self) {
        self.phase = RuntimePhase::Stopped;
        self.generation = None;
        self.last_error = None;
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), String> {
        if self
            .generation
            .as_ref()
            .is_some_and(|current| current.id == generation)
        {
            Ok(())
        } else {
            Err("stale Runtime generation".into())
        }
    }

    fn transition(
        &mut self,
        generation: u64,
        expected: RuntimePhase,
        next: RuntimePhase,
    ) -> Result<(), String> {
        self.ensure_generation(generation)?;
        if self.phase != expected {
            return Err("invalid Runtime lifecycle transition".into());
        }
        self.phase = next;
        Ok(())
    }
}

pub(crate) struct RuntimeActor {
    state: RuntimeActorState,
    process: Option<RuntimeProcess>,
    lease: Option<RuntimeLease>,
    cancellation: Option<(u64, CancellationToken)>,
}

impl Default for RuntimeActor {
    fn default() -> Self {
        Self {
            state: RuntimeActorState::default(),
            process: None,
            lease: None,
            cancellation: None,
        }
    }
}

impl RuntimeActor {
    pub(crate) fn state(&self) -> &RuntimeActorState {
        &self.state
    }

    pub(crate) fn phase(&self) -> RuntimePhase {
        self.state.phase()
    }

    pub(crate) fn generation_id(&self) -> Option<u64> {
        self.state.generation().map(|generation| generation.id)
    }

    pub(crate) fn lease(&self) -> Option<RuntimeLease> {
        self.lease.clone()
    }

    pub(crate) fn process(&self) -> Option<&RuntimeProcess> {
        self.process.as_ref()
    }

    pub(crate) fn process_mut(&mut self) -> Option<&mut RuntimeProcess> {
        self.process.as_mut()
    }

    pub(crate) fn begin_start(
        &mut self,
        mode: RuntimeMode,
    ) -> Result<(RuntimeGeneration, CancellationToken), String> {
        if self.state.is_transitioning() {
            return Err("Runtime 正在处理另一个生命周期操作，请稍候再试。".into());
        }
        if matches!(
            self.state.phase(),
            RuntimePhase::Ready | RuntimePhase::Degraded
        ) && self.process.is_some()
        {
            return Err("Runtime 已经处于可用状态。".into());
        }
        let generation = self.state.begin(mode)?;
        let cancellation = CancellationToken::new();
        self.cancellation = Some((generation.id, cancellation.clone()));
        self.lease = None;
        Ok((generation, cancellation))
    }

    pub(crate) fn bind_image(
        &mut self,
        generation: u64,
        image_identity: String,
    ) -> Result<RuntimeGeneration, String> {
        self.state.bind_image(generation, image_identity)?;
        self.state
            .generation()
            .cloned()
            .ok_or_else(|| "Runtime generation disappeared after image binding".to_string())
    }

    pub(crate) fn mark_starting(&mut self, generation: u64) -> Result<(), String> {
        self.state.mark_starting(generation)
    }

    pub(crate) fn mark_probing(&mut self, generation: u64) -> Result<(), String> {
        self.state.mark_probing(generation)
    }

    pub(crate) fn publish_ready(
        &mut self,
        generation: u64,
        process: RuntimeProcess,
        lease: RuntimeLease,
        degraded: bool,
    ) -> Result<(), RuntimeProcess> {
        let cancelled = self
            .cancellation
            .as_ref()
            .is_some_and(|(id, token)| *id != generation || token.is_cancelled());
        if cancelled
            || self
                .state
                .accept_ready_generation(generation, &lease.generation, degraded)
                .is_err()
        {
            return Err(process);
        }
        self.process = Some(process);
        self.lease = Some(lease);
        self.cancellation = None;
        Ok(())
    }

    pub(crate) fn mark_failed(&mut self, generation: u64, message: String) {
        self.state.mark_failed(generation, message);
        if self.generation_id() == Some(generation) {
            self.cancellation = None;
            self.lease = None;
        }
    }

    pub(crate) fn begin_stop(&mut self) -> Option<RuntimeProcess> {
        self.state.begin_stop();
        if let Some((_, cancellation)) = self.cancellation.as_ref() {
            cancellation.cancel();
        }
        self.lease = None;
        self.process.take()
    }

    pub(crate) fn settle_stopped(&mut self) {
        self.process = None;
        self.lease = None;
        self.cancellation = None;
        self.state.settle_stopped();
    }

    pub(crate) fn invalidate_dead_process(&mut self) -> Option<RuntimeProcess> {
        self.lease = None;
        self.cancellation = None;
        self.state.settle_stopped();
        self.process.take()
    }

    /// Explicit liveness reaper. Checks the owned process once and, only when
    /// it has actually exited, invalidates the actor state and returns the
    /// dead process so the caller can release its native resources.
    ///
    /// Callers are explicit lifecycle paths (status reconciliation, supervisor
    /// shutdown). Read-only status/probe paths use `runtime::status_snapshot_readonly`
    /// and must never call this, otherwise a snapshot read could revoke the
    /// lease consumed by the very navigation it is reporting on.
    pub(crate) fn reap_if_dead(&mut self) -> Option<RuntimeProcess> {
        let dead = self
            .process_mut()
            .is_some_and(|process| !process.is_alive());
        if dead {
            self.invalidate_dead_process()
        } else {
            None
        }
    }

    pub(crate) fn lease_is_current(&self, generation: u64) -> bool {
        self.lease
            .as_ref()
            .is_some_and(|lease| lease.generation.id == generation)
            && matches!(
                self.state.phase(),
                RuntimePhase::Ready | RuntimePhase::Degraded
            )
    }
}

fn generation_nonce() -> Result<String, String> {
    // `secure_random` and the hex encoding it feeds are shared with the Gateway
    // pairing flow, so both surfaces benefit from the same CSPRNG hardening.
    crate::crypto::random_hex(16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_allocates_a_new_generation() {
        let mut state = RuntimeActorState::default();
        let first = state.begin(RuntimeMode::Normal).unwrap();
        assert_eq!(first.id, 1);
        assert_eq!(first.nonce.len(), 32);
        assert_eq!(state.phase(), RuntimePhase::Preparing);
        state.settle_stopped();
        let second = state.begin(RuntimeMode::Safe).unwrap();
        assert_eq!(second.id, 2);
        assert_eq!(second.mode, RuntimeMode::Safe);
        assert_ne!(first.nonce, second.nonce);
    }

    #[test]
    fn stale_generation_cannot_mark_current_runtime_ready() {
        let mut state = RuntimeActorState::default();
        let first = state.begin(RuntimeMode::Normal).unwrap();
        state.settle_stopped();
        let second = state.begin(RuntimeMode::Normal).unwrap();
        state.mark_starting(second.id).unwrap();
        assert!(state.mark_ready(first.id, false).is_err());
        assert_eq!(state.phase(), RuntimePhase::Starting);
    }

    #[test]
    fn ready_publish_requires_the_complete_bound_generation() {
        let mut state = RuntimeActorState::default();
        let allocated = state.begin(RuntimeMode::Normal).unwrap();
        state
            .bind_image(allocated.id, "sha256:runtime-image".into())
            .unwrap();
        state.mark_starting(allocated.id).unwrap();
        let current = state.generation().unwrap().clone();

        let mut stale_id = current.clone();
        stale_id.id += 1;
        assert!(state
            .accept_ready_generation(allocated.id, &stale_id, false)
            .is_err());
        assert_eq!(state.phase(), RuntimePhase::Starting);

        let mut stale_nonce = current.clone();
        stale_nonce.nonce.push_str("-stale");
        assert!(state
            .accept_ready_generation(allocated.id, &stale_nonce, false)
            .is_err());
        assert_eq!(state.phase(), RuntimePhase::Starting);

        let mut stale_image = current.clone();
        stale_image.image_identity = "sha256:other-image".into();
        assert!(state
            .accept_ready_generation(allocated.id, &stale_image, false)
            .is_err());
        assert_eq!(state.phase(), RuntimePhase::Starting);

        let mut stale_mode = current.clone();
        stale_mode.mode = RuntimeMode::Safe;
        assert!(state
            .accept_ready_generation(allocated.id, &stale_mode, false)
            .is_err());
        assert_eq!(state.phase(), RuntimePhase::Starting);

        state
            .accept_ready_generation(allocated.id, &current, false)
            .unwrap();
        assert_eq!(state.phase(), RuntimePhase::Ready);
    }

    #[test]
    fn stop_during_probe_enters_explicit_cancellation() {
        let mut state = RuntimeActorState::default();
        let generation = state.begin(RuntimeMode::Normal).unwrap();
        state.mark_starting(generation.id).unwrap();
        state.mark_probing(generation.id).unwrap();
        state.begin_stop();
        assert_eq!(state.phase(), RuntimePhase::Cancelling);
        state.settle_stopped();
        assert_eq!(state.phase(), RuntimePhase::Stopped);
    }
}
