//! Tauri mobile adapter.
//!
//! Android/iOS are Remote Gateway clients. They intentionally do not own the
//! desktop Runtime, Native Gateway listener, tray/menu, single-instance or
//! desktop updater resources. Keeping this adapter separate prevents desktop
//! native APIs from leaking into mobile builds and makes the platform boundary
//! explicit at the composition root.

pub(crate) fn setup(_app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub(crate) fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {
    // Mobile OS lifecycle is owned by Tauri/the platform. Remote Gateway
    // sessions are server-side and no desktop managed process exists locally.
}
