//! Plugin Manager V2: host-side plugin lifecycle and quarantine metadata.
//! DeepSeek Harness remains the plugin runtime; HarnessDock never deletes user plugins.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
use crate::plugin_quarantine::{self, PluginQuarantineRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginLifecycleState { Discovered, Validated, Enabled, Failed, Quarantined, Recovering }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPlugin { pub id: String, pub state: PluginLifecycleState, pub suspected: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManagerSnapshot {
    pub runtime_version: Option<String>,
    pub runtime_image_identity: Option<String>,
    pub recovery_source: String,
    pub safe_mode: bool,
    pub quarantine_expires_at: Option<u64>,
    pub plugins: Vec<ManagedPlugin>,
}
impl Default for PluginManagerSnapshot {
    fn default() -> Self {
        Self { runtime_version: None, runtime_image_identity: None, recovery_source: "none".into(), safe_mode: false, quarantine_expires_at: None, plugins: Vec::new() }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PluginManagerState { snapshot: PluginManagerSnapshot }
impl PluginManagerState {
    pub(crate) fn snapshot(&self) -> PluginManagerSnapshot { self.snapshot.clone() }
    pub(crate) fn observe_runtime(
        &mut self,
        version: String,
        image: String,
        source: String,
        safe: bool,
        isolated: &[String],
        suspected: &[String],
        expires: Option<u64>,
    ) {
        if isolated.is_empty() {
            for plugin in &mut self.snapshot.plugins {
                if matches!(plugin.state, PluginLifecycleState::Recovering | PluginLifecycleState::Failed) {
                    plugin.state = PluginLifecycleState::Enabled;
                    plugin.suspected = false;
                }
            }
        } else {
            self.snapshot.plugins = isolated.iter().map(|id| ManagedPlugin {
                id: id.clone(),
                state: PluginLifecycleState::Quarantined,
                suspected: suspected.contains(id),
            }).collect();
        }
        self.snapshot.runtime_version = Some(version);
        self.snapshot.runtime_image_identity = Some(image);
        self.snapshot.recovery_source = source;
        self.snapshot.safe_mode = safe;
        self.snapshot.quarantine_expires_at = expires;
    }
    pub(crate) fn begin_recovery(&mut self) {
        for plugin in &mut self.snapshot.plugins {
            if matches!(plugin.state, PluginLifecycleState::Quarantined | PluginLifecycleState::Failed) {
                plugin.state = PluginLifecycleState::Recovering;
            }
        }
        self.snapshot.recovery_source = "operator-clear".into();
        self.snapshot.quarantine_expires_at = None;
    }
}

pub(crate) fn load_quarantine(path: &Path, version: &str, image: &str, scope: &str) -> Option<PluginQuarantineRecord> {
    plugin_quarantine::read(path, version, image, scope)
}
pub(crate) fn persist_quarantine(
    path: &Path,
    version: &str,
    image: &str,
    scope: &str,
    isolated: Vec<String>,
    suspected: Vec<String>,
    reason: &str,
) -> Result<PluginQuarantineRecord, String> {
    plugin_quarantine::write(path, version, image, scope, isolated, suspected, reason)
}
pub(crate) fn clear_quarantine(path: &Path) -> Result<(), String> { plugin_quarantine::clear(path) }

#[tauri::command]
pub fn plugin_manager_status(state: State<'_, crate::AppState>) -> PluginManagerSnapshot {
    state.plugin_manager.lock().map(|m| m.snapshot()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quarantine_recovery_cycle() {
        let mut manager = PluginManagerState::default();
        manager.observe_runtime("0.1.6".into(), "sha256:image".into(), "quarantine".into(), false, &["bad".into()], &["bad".into()], Some(1));
        manager.begin_recovery();
        assert_eq!(manager.snapshot().plugins[0].state, PluginLifecycleState::Recovering);
        manager.observe_runtime("0.1.6".into(), "sha256:image".into(), "none".into(), false, &[], &[], None);
        assert_eq!(manager.snapshot().plugins[0].state, PluginLifecycleState::Enabled);
    }
}
