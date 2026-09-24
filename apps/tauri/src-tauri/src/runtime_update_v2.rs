//! Runtime Update V2: sealed A/B Runtime activation and rollback.

use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{path::BaseDirectory, AppHandle, Manager, State, WebviewWindow};

const SCHEMA_VERSION: u8 = 2;
const STATE_FILE: &str = "runtime-update-v2.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeSlot { Bundled, A, B }

impl RuntimeSlot {
    fn directory(self) -> Option<&'static str> {
        match self { Self::Bundled => None, Self::A => Some("slot-a"), Self::B => Some("slot-b") }
    }
    fn inactive(active: Self) -> Self {
        match active { Self::A => Self::B, Self::B | Self::Bundled => Self::A }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeUpdatePhase { Idle, Staged, Activating, Validating, Succeeded, RollingBack, Failed }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRecord {
    schema_version: u8,
    active: RuntimeSlot,
    previous: Option<RuntimeSlot>,
    candidate: Option<RuntimeSlot>,
    updated_at: u64,
    #[serde(default)]
    last_rollback_reason: Option<String>,
}
impl Default for ActivationRecord {
    fn default() -> Self {
        Self { schema_version: SCHEMA_VERSION, active: RuntimeSlot::Bundled, previous: None, candidate: None, updated_at: now_secs(), last_rollback_reason: None }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedManifest {
    dsh_version: String,
    image_identity: String,
    #[serde(default)] platform: Option<String>,
    #[serde(default)] arch: Option<String>,
    #[serde(default)] runtime_embedded: Option<bool>,
    #[serde(default)] first_launch_runtime_download_required: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSlotInfo {
    pub slot: RuntimeSlot,
    pub dsh_version: String,
    pub image_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateSnapshot {
    pub phase: RuntimeUpdatePhase,
    pub active: RuntimeSlotInfo,
    pub previous: Option<RuntimeSlotInfo>,
    pub candidate: Option<RuntimeSlotInfo>,
    pub last_rollback_reason: Option<String>,
    pub last_error: Option<String>,
}
impl Default for RuntimeUpdateSnapshot {
    fn default() -> Self {
        Self {
            phase: RuntimeUpdatePhase::Idle,
            active: RuntimeSlotInfo { slot: RuntimeSlot::Bundled, dsh_version: "unknown".into(), image_identity: "unknown".into() },
            previous: None,
            candidate: None,
            last_rollback_reason: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct RuntimeUpdateState { snapshot: RuntimeUpdateSnapshot }
impl RuntimeUpdateState {
    pub(crate) fn snapshot(&self) -> RuntimeUpdateSnapshot { self.snapshot.clone() }
    fn publish(&mut self, value: RuntimeUpdateSnapshot) { self.snapshot = value; }
    fn phase(&mut self, phase: RuntimeUpdatePhase) { self.snapshot.phase = phase; self.snapshot.last_error = None; }
    fn fail(&mut self, error: String) { self.snapshot.phase = RuntimeUpdatePhase::Failed; self.snapshot.last_error = Some(error); }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_secs()).unwrap_or(0)
}
fn update_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|p| p.join("runtime-v2")).map_err(|e| format!("Runtime Update V2 path: {e}"))
}
fn state_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(update_root(app)?.join(STATE_FILE)) }
fn slot_root(app: &AppHandle, slot: RuntimeSlot) -> Result<PathBuf, String> {
    match slot.directory() {
        Some(name) => Ok(update_root(app)?.join(name).join("dsh-runtime")),
        None => app.path().resolve("dsh-runtime", BaseDirectory::Resource).map_err(|e| format!("bundled Runtime path: {e}")),
    }
}
fn node_path(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") { root.join("node.exe") } else { root.join("bin").join("node") }
}
fn dsh_path(root: &Path) -> PathBuf {
    root.join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js")
}
fn expected_platform() -> &'static str {
    if cfg!(target_os = "windows") { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" }
}
fn expected_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") { "x64" } else if cfg!(target_arch = "aarch64") { "arm64" } else { std::env::consts::ARCH }
}
fn valid_identity(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn inspect(slot: RuntimeSlot, root: &Path) -> Result<RuntimeSlotInfo, String> {
    if !root.is_dir() || !node_path(root).is_file() || !dsh_path(root).is_file() {
        return Err(format!("Runtime slot {:?} incomplete", slot));
    }
    let manifest: SealedManifest = serde_json::from_str(
        &fs::read_to_string(root.join("manifest.json")).map_err(|e| format!("Runtime manifest read: {e}"))?
    ).map_err(|e| format!("Runtime manifest invalid: {e}"))?;
    if manifest.dsh_version.trim().is_empty() || !valid_identity(&manifest.image_identity) {
        return Err("Runtime sealed identity invalid".into());
    }
    if manifest.platform.as_deref().is_some_and(|v| v != expected_platform())
        || manifest.arch.as_deref().is_some_and(|v| v != expected_arch()) {
        return Err("Runtime target mismatch".into());
    }
    if manifest.runtime_embedded == Some(false) || manifest.first_launch_runtime_download_required == Some(true) {
        return Err("Runtime candidate is not sealed/offline".into());
    }
    Ok(RuntimeSlotInfo { slot, dsh_version: manifest.dsh_version, image_identity: manifest.image_identity })
}
fn read_record(app: &AppHandle) -> ActivationRecord {
    state_path(app).ok().and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<ActivationRecord>(&s).ok())
        .filter(|r| r.schema_version == SCHEMA_VERSION).unwrap_or_default()
}
fn write_record(app: &AppHandle, record: &ActivationRecord) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Err(first) = fs::rename(&tmp, &path) {
        if !path.exists() { return Err(format!("Runtime state commit failed: {first}")); }
        fs::remove_file(&path).map_err(|e| format!("Runtime state replace failed: {e}; {first}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("Runtime state commit failed: {e}; {first}"))?;
    }
    Ok(())
}
fn info(app: &AppHandle, slot: RuntimeSlot) -> Option<RuntimeSlotInfo> {
    slot_root(app, slot).ok().and_then(|p| inspect(slot, &p).ok())
}
fn snapshot(app: &AppHandle, phase: RuntimeUpdatePhase) -> Result<RuntimeUpdateSnapshot, String> {
    let r = read_record(app);
    Ok(RuntimeUpdateSnapshot {
        phase,
        active: inspect(r.active, &slot_root(app, r.active)?)?,
        previous: r.previous.and_then(|s| info(app, s)),
        candidate: r.candidate.and_then(|s| info(app, s)),
        last_rollback_reason: r.last_rollback_reason,
        last_error: None,
    })
}
fn publish(app: &AppHandle, value: RuntimeUpdateSnapshot) {
    if let Ok(mut state) = app.state::<crate::AppState>().runtime_update.lock() { state.publish(value); }
}

pub(crate) fn resolve_active_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut r = read_record(app);
    let active = slot_root(app, r.active)?;
    if inspect(r.active, &active).is_ok() {
        if let Ok(s) = snapshot(app, RuntimeUpdatePhase::Idle) { publish(app, s); }
        return Ok(active);
    }
    let failed = r.active;
    let fallback = r.previous
        .and_then(|s| slot_root(app, s).ok().map(|p| (s, p)))
        .filter(|(s, p)| *s != failed && inspect(*s, p).is_ok())
        .unwrap_or((RuntimeSlot::Bundled, slot_root(app, RuntimeSlot::Bundled)?));
    inspect(fallback.0, &fallback.1)?;
    r.active = fallback.0;
    r.previous = Some(failed);
    r.candidate = None;
    r.updated_at = now_secs();
    r.last_rollback_reason = Some(format!("slot {:?} failed sealed validation", failed));
    write_record(app, &r)?;
    if let Ok(s) = snapshot(app, RuntimeUpdatePhase::RollingBack) { publish(app, s); }
    Ok(fallback.1)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() { return Err("Runtime candidate symlink rejected".into()); }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::copy(source, destination).map_err(|e| e.to_string())?;
        let _ = fs::set_permissions(destination, metadata.permissions());
        return Ok(());
    }
    if !metadata.is_dir() { return Err("unsupported Runtime candidate file type".into()); }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}
fn stage(app: &AppHandle, source: &Path) -> Result<RuntimeUpdateSnapshot, String> {
    let source_info = inspect(RuntimeSlot::Bundled, source)?;
    let mut r = read_record(app);
    let slot = RuntimeSlot::inactive(r.active);
    let final_root = slot_root(app, slot)?;
    let container = final_root.parent().ok_or("Runtime slot parent missing")?.to_path_buf();
    let staging = container.with_extension(format!("staging-{}-{}", std::process::id(), now_secs()));
    let _ = fs::remove_dir_all(&staging);
    let staged_root = staging.join("dsh-runtime");
    copy_tree(source, &staged_root)?;
    let staged = inspect(slot, &staged_root)?;
    if staged.dsh_version != source_info.dsh_version || staged.image_identity != source_info.image_identity {
        let _ = fs::remove_dir_all(&staging);
        return Err("Runtime candidate identity changed during staging".into());
    }
    let _ = fs::remove_dir_all(&container);
    fs::rename(&staging, &container).map_err(|e| format!("Runtime slot commit failed: {e}"))?;
    r.candidate = Some(slot);
    r.updated_at = now_secs();
    r.last_rollback_reason = None;
    write_record(app, &r)?;
    let s = snapshot(app, RuntimeUpdatePhase::Staged)?;
    publish(app, s.clone());
    Ok(s)
}
async fn activate(app: AppHandle) -> Result<RuntimeUpdateSnapshot, String> {
    let mut r = read_record(&app);
    let candidate = r.candidate.ok_or("no staged Runtime candidate")?;
    let expected = info(&app, candidate).ok_or("candidate sealed validation failed")?;
    let previous = r.active;
    if let Ok(mut s) = app.state::<crate::AppState>().runtime_update.lock() { s.phase(RuntimeUpdatePhase::Activating); }
    r.active = candidate; r.previous = Some(previous); r.candidate = None; r.updated_at = now_secs(); write_record(&app, &r)?;
    if let Ok(mut s) = app.state::<crate::AppState>().runtime_update.lock() { s.phase(RuntimeUpdatePhase::Validating); }
    let started = crate::runtime::restart_managed(app.clone()).await;
    let valid = started.as_ref().ok().is_some_and(|s|
        s.dsh_version.as_deref() == Some(expected.dsh_version.as_str())
        && s.image_identity.as_deref() == Some(expected.image_identity.as_str())
        && s.app_url.is_some()
    );
    if valid {
        let s = snapshot(&app, RuntimeUpdatePhase::Succeeded)?; publish(&app, s.clone()); return Ok(s);
    }
    let reason = started.err().unwrap_or_else(|| "candidate ready identity mismatch".into());
    if let Ok(mut s) = app.state::<crate::AppState>().runtime_update.lock() { s.phase(RuntimeUpdatePhase::RollingBack); }
    r.active = previous; r.previous = Some(candidate); r.updated_at = now_secs(); r.last_rollback_reason = Some(reason.clone()); write_record(&app, &r)?;
    if let Err(e) = crate::runtime::restart_managed(app.clone()).await {
        let message = format!("Runtime candidate failed: {reason}; rollback failed: {e}");
        if let Ok(mut s) = app.state::<crate::AppState>().runtime_update.lock() { s.fail(message.clone()); }
        return Err(message);
    }
    let message = format!("Runtime candidate failed and rolled back: {reason}");
    if let Ok(mut s) = app.state::<crate::AppState>().runtime_update.lock() { s.fail(message.clone()); }
    Err(message)
}
async fn rollback(app: AppHandle) -> Result<RuntimeUpdateSnapshot, String> {
    let mut r = read_record(&app);
    let previous = r.previous.ok_or("no previous Runtime slot")?;
    inspect(previous, &slot_root(&app, previous)?)?;
    let current = r.active;
    r.active = previous; r.previous = Some(current); r.candidate = None; r.updated_at = now_secs(); r.last_rollback_reason = Some("operator rollback".into());
    write_record(&app, &r)?;
    crate::runtime::restart_managed(app.clone()).await?;
    let s = snapshot(&app, RuntimeUpdatePhase::Succeeded)?; publish(&app, s.clone()); Ok(s)
}
fn authorize(window: &WebviewWindow<tauri::Wry>) -> Result<(), String> {
    match window.label() { "settings" | "control" => Ok(()), _ => Err("Runtime Update V2 only allows control/diagnostics".into()) }
}

#[tauri::command]
pub fn runtime_update_status(app: AppHandle, state: State<'_, crate::AppState>) -> RuntimeUpdateSnapshot {
    let phase = state.runtime_update.lock().map(|s| s.snapshot.phase).unwrap_or(RuntimeUpdatePhase::Idle);
    match snapshot(&app, phase) {
        Ok(s) => { publish(&app, s.clone()); s }
        Err(e) => { let mut s = state.runtime_update.lock().map(|v| v.snapshot()).unwrap_or_default(); s.last_error = Some(e); s }
    }
}
#[tauri::command]
pub async fn runtime_update_stage_candidate(app: AppHandle, window: WebviewWindow<tauri::Wry>, source: String) -> Result<RuntimeUpdateSnapshot, String> {
    authorize(&window)?;
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || stage(&task_app, Path::new(&source))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn runtime_update_activate(app: AppHandle, window: WebviewWindow<tauri::Wry>) -> Result<RuntimeUpdateSnapshot, String> {
    authorize(&window)?; activate(app).await
}
#[tauri::command]
pub async fn runtime_update_rollback(app: AppHandle, window: WebviewWindow<tauri::Wry>) -> Result<RuntimeUpdateSnapshot, String> {
    authorize(&window)?; rollback(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn inactive_slot_alternates() {
        assert_eq!(RuntimeSlot::inactive(RuntimeSlot::Bundled), RuntimeSlot::A);
        assert_eq!(RuntimeSlot::inactive(RuntimeSlot::A), RuntimeSlot::B);
    }
    #[test] fn identity_shape() {
        assert!(valid_identity(&format!("sha256:{}", "a".repeat(64))));
        assert!(!valid_identity("sha256:abc"));
    }
}
