use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeIntent {
    Start,
    Restart,
    Stop,
    MarkProbing,
    MarkReady,
    MarkDegraded,
    MarkFailed,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeActorState {
    phase: RuntimePhase,
    generation: u64,
}

impl Default for RuntimeActorState {
    fn default() -> Self {
        Self {
            phase: RuntimePhase::Stopped,
            generation: 0,
        }
    }
}

impl RuntimeActorState {
    pub fn phase(&self) -> RuntimePhase {
        self.phase
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn apply(&mut self, intent: RuntimeIntent) -> Result<(), &'static str> {
        use RuntimeIntent::*;
        use RuntimePhase::*;

        let next = match (self.phase, intent) {
            (Stopped, Start) | (Failed, Start) => {
                self.generation = self.generation.saturating_add(1);
                Preparing
            }
            (Ready, Restart) | (Degraded, Restart) | (Failed, Restart) => {
                self.generation = self.generation.saturating_add(1);
                Stopping
            }
            (Preparing, MarkProbing) | (Starting, MarkProbing) => Probing,
            (Preparing, MarkReady) | (Starting, MarkReady) | (Probing, MarkReady) => Ready,
            (Ready, MarkDegraded) | (Probing, MarkDegraded) => Degraded,
            (Preparing, MarkFailed)
            | (Starting, MarkFailed)
            | (Probing, MarkFailed)
            | (Stopping, MarkFailed)
            | (Cancelling, MarkFailed) => Failed,
            (Preparing, Cancel) | (Starting, Cancel) | (Probing, Cancel) => Cancelling,
            (Preparing, Stop)
            | (Starting, Stop)
            | (Probing, Stop)
            | (Ready, Stop)
            | (Degraded, Stop)
            | (Failed, Stop) => Stopping,
            (Stopping, Start) | (Cancelling, Start) => {
                return Err("runtime lifecycle transition is still settling")
            }
            (Stopped, Stop) => Stopped,
            (Stopping, MarkReady) | (Cancelling, MarkReady) => {
                return Err("stale ready signal for a stopping runtime generation")
            }
            (Stopped, MarkReady) | (Failed, MarkReady) => {
                return Err("ready signal without an active runtime generation")
            }
            (Stopped, Restart) => {
                self.generation = self.generation.saturating_add(1);
                Preparing
            }
            (Stopping, Cancel) | (Cancelling, Cancel) => Cancelling,
            (Stopping, Stop) | (Cancelling, Stop) => self.phase,
            (Ready, Start) | (Degraded, Start) => self.phase,
            (Failed, MarkFailed) | (Stopped, MarkFailed) => Failed,
            _ => return Err("invalid runtime lifecycle transition"),
        };

        self.phase = next;
        Ok(())
    }

    pub fn settle_stopped(&mut self) {
        self.phase = RuntimePhase::Stopped;
    }

    pub fn mark_starting(&mut self) -> Result<(), &'static str> {
        match self.phase {
            RuntimePhase::Preparing => {
                self.phase = RuntimePhase::Starting;
                Ok(())
            }
            _ => Err("runtime can only enter starting from preparing"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_allocates_a_new_generation() {
        let mut state = RuntimeActorState::default();
        state.apply(RuntimeIntent::Start).unwrap();
        assert_eq!(state.phase(), RuntimePhase::Preparing);
        assert_eq!(state.generation(), 1);
    }

    #[test]
    fn restart_is_a_generation_change_not_a_boolean_flag() {
        let mut state = RuntimeActorState::default();
        state.apply(RuntimeIntent::Start).unwrap();
        state.mark_starting().unwrap();
        state.apply(RuntimeIntent::MarkReady).unwrap();
        assert_eq!(state.generation(), 1);

        state.apply(RuntimeIntent::Restart).unwrap();
        assert_eq!(state.phase(), RuntimePhase::Stopping);
        assert_eq!(state.generation(), 2);
    }

    #[test]
    fn stale_ready_is_rejected_while_stopping() {
        let mut state = RuntimeActorState::default();
        state.apply(RuntimeIntent::Start).unwrap();
        state.mark_starting().unwrap();
        state.apply(RuntimeIntent::Stop).unwrap();
        let error = state.apply(RuntimeIntent::MarkReady).unwrap_err();
        assert!(error.contains("stale ready"));
    }

    #[test]
    fn cancellation_is_explicit_lifecycle_state() {
        let mut state = RuntimeActorState::default();
        state.apply(RuntimeIntent::Start).unwrap();
        state.mark_starting().unwrap();
        state.apply(RuntimeIntent::Cancel).unwrap();
        assert_eq!(state.phase(), RuntimePhase::Cancelling);
        state.settle_stopped();
        assert_eq!(state.phase(), RuntimePhase::Stopped);
    }
}
