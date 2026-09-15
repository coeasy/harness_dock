use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Downloading,
    Installing,
    Restarting,
    Failed,
}

#[derive(Debug, Clone)]
pub(crate) struct UpdateActorState {
    phase: UpdatePhase,
}

impl Default for UpdateActorState {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
        }
    }
}

impl UpdateActorState {
    pub(crate) fn phase(&self) -> UpdatePhase {
        self.phase
    }

    pub(crate) fn begin(&mut self) -> Result<(), String> {
        if self.phase != UpdatePhase::Idle && self.phase != UpdatePhase::Failed {
            return Err("HarnessDock 正在处理另一个更新操作，请稍候。".into());
        }
        self.phase = UpdatePhase::Checking;
        Ok(())
    }

    pub(crate) fn transition(&mut self, phase: UpdatePhase) {
        self.phase = phase;
    }

    pub(crate) fn finish(&mut self) {
        self.phase = UpdatePhase::Idle;
    }

    pub(crate) fn fail(&mut self) {
        self.phase = UpdatePhase::Failed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_actor_serializes_update_work() {
        let mut state = UpdateActorState::default();
        state.begin().unwrap();
        assert!(state.begin().is_err());
        state.transition(UpdatePhase::Downloading);
        state.finish();
        assert_eq!(state.phase(), UpdatePhase::Idle);
    }
}
