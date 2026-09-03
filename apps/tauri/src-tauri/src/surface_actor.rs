use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceKind {
    Harness,
    Recovery,
    Gateway,
    Diagnostics,
    Splash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfacePhase {
    Hidden,
    Loading,
    Visible,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceOperation {
    Idle,
    Refresh,
    Restart,
    SafeMode,
    Update,
    Diagnostics,
}

#[derive(Debug, Clone)]
pub(crate) struct SurfaceActorState {
    phase: SurfacePhase,
    operation: SurfaceOperation,
    navigation_id: u64,
    runtime_generation: Option<u64>,
    primary_visible: bool,
}

impl Default for SurfaceActorState {
    fn default() -> Self {
        Self {
            phase: SurfacePhase::Hidden,
            operation: SurfaceOperation::Idle,
            navigation_id: 0,
            runtime_generation: None,
            primary_visible: false,
        }
    }
}

impl SurfaceActorState {
    pub(crate) fn phase(&self) -> SurfacePhase {
        self.phase
    }

    pub(crate) fn operation(&self) -> SurfaceOperation {
        self.operation
    }

    pub(crate) fn primary_visible(&self) -> bool {
        self.primary_visible
    }

    pub(crate) fn runtime_generation(&self) -> Option<u64> {
        self.runtime_generation
    }

    pub(crate) fn current_navigation(&self) -> (u64, Option<u64>) {
        (self.navigation_id, self.runtime_generation)
    }

    pub(crate) fn begin_operation(&mut self, operation: SurfaceOperation) -> Result<(), String> {
        if self.operation != SurfaceOperation::Idle {
            return Err("Harness surface 正在处理另一个操作，请稍候。".into());
        }
        self.operation = operation;
        Ok(())
    }

    pub(crate) fn end_operation(&mut self) {
        self.operation = SurfaceOperation::Idle;
    }

    pub(crate) fn begin_navigation(&mut self, runtime_generation: u64) -> u64 {
        self.navigation_id = self.navigation_id.saturating_add(1);
        self.runtime_generation = Some(runtime_generation);
        self.phase = SurfacePhase::Loading;
        self.primary_visible = false;
        self.navigation_id
    }

    pub(crate) fn finish_navigation(
        &mut self,
        navigation_id: u64,
        runtime_generation: u64,
    ) -> bool {
        if self.navigation_id != navigation_id
            || self.runtime_generation != Some(runtime_generation)
            || self.phase != SurfacePhase::Loading
        {
            return false;
        }
        self.phase = SurfacePhase::Visible;
        self.primary_visible = true;
        true
    }

    pub(crate) fn fail_navigation(
        &mut self,
        navigation_id: u64,
        runtime_generation: u64,
    ) -> bool {
        if self.navigation_id != navigation_id
            || self.runtime_generation != Some(runtime_generation)
        {
            return false;
        }
        self.phase = SurfacePhase::Failed;
        self.primary_visible = false;
        true
    }

    pub(crate) fn cancel_navigation(&mut self) {
        self.navigation_id = self.navigation_id.saturating_add(1);
        self.runtime_generation = None;
        self.phase = SurfacePhase::Hidden;
        self.primary_visible = false;
    }

    pub(crate) fn hide(&mut self) {
        self.cancel_navigation();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_navigation_callback_cannot_publish_visibility() {
        let mut state = SurfaceActorState::default();
        let first = state.begin_navigation(1);
        let second = state.begin_navigation(1);
        assert!(!state.finish_navigation(first, 1));
        assert!(state.finish_navigation(second, 1));
        assert!(state.primary_visible());
    }

    #[test]
    fn old_runtime_generation_cannot_finish_new_surface() {
        let mut state = SurfaceActorState::default();
        let navigation = state.begin_navigation(9);
        assert!(!state.finish_navigation(navigation, 8));
        assert_eq!(state.phase(), SurfacePhase::Loading);
    }
}
