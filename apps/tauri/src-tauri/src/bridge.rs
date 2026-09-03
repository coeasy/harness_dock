//! Tauri IPC adapter registry.
//!
//! Business logic remains in the host/workflow layer. This module only owns
//! the concrete command registration required by Tauri while Round 1 moves
//! the public surface toward the versioned Host Protocol.

macro_rules! handler {
    () => {
        tauri::generate_handler![
            $crate::platform::platform_info,
            $crate::gateway::gateway_health,
            $crate::gateway::pair_gateway,
            $crate::gateway_host::gateway_host_status,
            $crate::gateway_host::gateway_host_start,
            $crate::gateway_host::gateway_host_create_pairing,
            $crate::gateway_host::gateway_host_revoke,
            $crate::gateway_host::gateway_host_revoke_all,
            $crate::gateway_host::gateway_host_stop,
            $crate::harness_window::harness_open,
            $crate::harness_window::harness_close,
            $crate::harness_window::harness_minimize,
            $crate::harness_window::harness_toggle_maximize,
            $crate::harness_window::harness_window_state,
            $crate::harness_shell::harness_shell_close,
            $crate::harness_window::control_show,
            $crate::harness_window::harness_reload_web,
            $crate::harness_window::harness_restart_web,
            $crate::harness_window::harness_safe_mode_restart,
            $crate::harness_window::harness_clear_quarantine_restart,
            $crate::harness_window::shell_settings_show,
            $crate::harness_window::shell_settings_close,
            $crate::harness_window::splash_status,
            $crate::harness_window::startup_recovery_status,
            $crate::harness_window::app_quit,
            $crate::runtime::runtime_status,
            $crate::runtime::runtime_start,
            $crate::runtime::runtime_stop,
            $crate::runtime::runtime_clear_plugin_quarantine,
            $crate::update::update_check,
            $crate::update::update_install,
        ]
    };
}

pub(crate) use handler;
