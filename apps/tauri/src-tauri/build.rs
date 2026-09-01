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
        "harness_reload_web",
        "harness_restart_web",
        "shell_settings_show",
        "shell_settings_close",
        "runtime_status",
        "runtime_start",
        "runtime_restart",
        "runtime_stop",
        "update_check",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build HarnessDock Tauri manifest");
}
