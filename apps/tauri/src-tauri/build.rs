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
        "control_show",
        "runtime_status",
        "runtime_start",
        "runtime_stop",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build HarnessDock Tauri manifest");
}
