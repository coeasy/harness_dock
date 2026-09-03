#[macro_use]
mod bridge;
mod capability_broker;
mod desktop;
mod gateway;
mod gateway_host;
mod harness_shell;
mod harness_window;
mod host_kernel;
mod host_protocol;
mod lifecycle;
mod platform;
mod plugin_quarantine;
mod process;
mod reconciler;
mod runtime;
mod runtime_actor;
mod service;
mod startup;
mod startup_trace;
mod state;
mod supervisor;
mod surface_actor;
mod tray;
mod update;
mod update_actor;

pub(crate) use state::AppState;
pub(crate) use supervisor::{request_exit, stop_managed_processes, wait_for_managed_processes};

/// HarnessDock v0.2.0 Native Host ownership map:
///
/// Tauri Adapter -> Host Protocol -> HostKernelTask -> Capability Broker
/// -> Desired State / Reconciler -> Resource Actors -> RuntimeLease.
///
/// Long-lived native resources are owned by their actor state. Renderers submit
/// typed intent only; normal startup has no permanent hidden control renderer.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    startup_trace::mark(startup_trace::StartupPhase::ProcessStarted);
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            host_kernel::install(app.handle().clone()).map_err(std::io::Error::other)?;
            desktop::setup(app)
        })
        .invoke_handler(bridge::handler!())
        .build(tauri::generate_context!())
        .expect("error while building HarnessDock")
        .run(desktop::handle_run_event);
}
