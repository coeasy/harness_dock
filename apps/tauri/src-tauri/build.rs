fn main() {
    const COMMANDS: &[&str] = &[
        "platform_info",
        "gateway_health",
        "pair_gateway",
        "gateway_host_status",
        "gateway_host_start",
        "gateway_host_create_pairing",
        "gateway_host_revoke",
        "gateway_host_revoke_all",
        "gateway_host_stop",
        "harness_open",
        "harness_close",
        "harness_minimize",
        "harness_toggle_maximize",
        "harness_window_state",
        "control_show",
        "control_hide",
        "harness_reload_web",
        "harness_restart_web",
        "harness_safe_mode_restart",
        "harness_clear_quarantine_restart",
        "shell_settings_show",
        "shell_settings_close",
        "splash_status",
        "runtime_status",
        "runtime_start",
        "runtime_restart",
        "runtime_stop",
        "update_check",
        "update_install",
        "app_quit",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build HarnessDock Tauri manifest");
}
