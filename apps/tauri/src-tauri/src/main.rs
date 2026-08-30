use serde::Deserialize;
use std::{
    env,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeState {
    status: String,
    app_url: Option<String>,
    message: Option<String>,
}

struct RuntimeBridgeProcess {
    child: Child,
    shutdown_file: PathBuf,
}

struct RuntimeResources {
    bridge: PathBuf,
    origin: PathBuf,
    plugin: PathBuf,
    bundled_root: Option<PathBuf>,
    packaged_node: Option<PathBuf>,
}

type SharedRuntime = Arc<Mutex<Option<RuntimeBridgeProcess>>>;
type AllowedOrigin = Arc<Mutex<Option<String>>>;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn node_path(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        root.join("node.exe")
    } else {
        root.join("bin/node")
    }
}

fn runtime_resources(app: &tauri::App) -> Result<RuntimeResources, String> {
    if cfg!(debug_assertions) {
        let root = repo_root();
        let bundled = root.join("runtimes/pack");
        let bundled_root = bundled.exists().then_some(bundled);
        let packaged_node = bundled_root
            .as_ref()
            .map(|runtime| node_path(runtime))
            .filter(|node| node.exists());
        return Ok(RuntimeResources {
            bridge: root.join("apps/tauri/dist/runtime-bridge.mjs"),
            origin: root.join("packages/docs-sync/origin.json"),
            plugin: root.join("packages/plugin-embedded-client/lib/index.js"),
            bundled_root,
            packaged_node,
        });
    }

    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    let full_root = resources.join("runtime/dsh-runtime");
    let thin_root = resources.join("runtime/node");
    let bundled_root = full_root.exists().then_some(full_root);
    let packaged_node = bundled_root
        .as_ref()
        .map(|runtime| node_path(runtime))
        .filter(|node| node.exists())
        .or_else(|| {
            let node = node_path(&thin_root);
            node.exists().then_some(node)
        });
    Ok(RuntimeResources {
        bridge: resources.join("runtime/runtime-bridge.mjs"),
        origin: resources.join("runtime/origin.json"),
        plugin: resources.join("runtime/plugin/index.js"),
        bundled_root,
        packaged_node,
    })
}

fn set_status(window: &WebviewWindow, message: &str) {
    if let Ok(payload) = serde_json::to_string(message) {
        let _ = window.eval(&format!("window.__HARNESSDOCK_SET_STATUS?.({payload})"));
    }
}

fn launch_runtime_bridge(
    app: &tauri::App,
    window: WebviewWindow,
    allowed_origin: AllowedOrigin,
) -> Result<RuntimeBridgeProcess, String> {
    let resources = runtime_resources(app)?;
    for required in [&resources.bridge, &resources.origin, &resources.plugin] {
        if !required.exists() {
            return Err(format!(
                "Missing Tauri runtime input: {}. Run `pnpm check:tauri-host` or rebuild the package.",
                required.display()
            ));
        }
    }

    let runtime_work = env::temp_dir().join(format!("harnessdock-tauri-{}", std::process::id()));
    fs::create_dir_all(&runtime_work).map_err(|error| error.to_string())?;
    let state_file = runtime_work.join("bridge-state.json");
    let shutdown_file = runtime_work.join("shutdown");
    let _ = fs::remove_file(&state_file);
    let _ = fs::remove_file(&shutdown_file);

    let user_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;

    let node = env::var_os("HARNESSDOCK_NODE")
        .map(PathBuf::from)
        .or(resources.packaged_node.clone())
        .unwrap_or_else(|| PathBuf::from("node"));
    if !cfg!(debug_assertions) && env::var_os("HARNESSDOCK_NODE").is_none() && resources.packaged_node.is_none() {
        return Err("Packaged Tauri host is missing its bundled Node runtime.".to_string());
    }

    let mut command = Command::new(&node);
    command
        .arg(&resources.bridge)
        .arg("--origin")
        .arg(&resources.origin)
        .arg("--plugin")
        .arg(&resources.plugin)
        .arg("--user-data")
        .arg(&user_data)
        .arg("--state-file")
        .arg(&state_file)
        .arg("--shutdown-file")
        .arg(&shutdown_file)
        .arg(format!("--packaged={}", !cfg!(debug_assertions)))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(root) = resources.bundled_root {
        command.arg("--bundled-root").arg(root);
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "Failed to start Tauri runtime bridge with {}: {error}",
            node.display()
        )
    })?;

    thread::spawn(move || {
        for _ in 0..480 {
            if let Ok(raw) = fs::read_to_string(&state_file) {
                if let Ok(state) = serde_json::from_str::<BridgeState>(&raw) {
                    match state.status.as_str() {
                        "ready" => {
                            let Some(app_url) = state.app_url else {
                                set_status(&window, "Runtime bridge reported ready without an app URL.");
                                return;
                            };
                            match Url::parse(&app_url) {
                                Ok(url) => {
                                    if let Ok(mut allowed) = allowed_origin.lock() {
                                        *allowed = Some(url.origin().ascii_serialization());
                                    }
                                    if let Err(error) = window.navigate(url) {
                                        set_status(&window, &format!("Harness UI navigation failed: {error}"));
                                    }
                                }
                                Err(error) => set_status(
                                    &window,
                                    &format!("Runtime bridge returned an invalid app URL: {error}"),
                                ),
                            }
                            return;
                        }
                        "error" => {
                            set_status(
                                &window,
                                state.message.as_deref().unwrap_or("Harness runtime failed to start."),
                            );
                            return;
                        }
                        _ => {}
                    }
                }
            }
            thread::sleep(Duration::from_millis(250));
        }
        set_status(&window, "Timed out waiting for the Harness runtime ready handshake.");
    });

    Ok(RuntimeBridgeProcess { child, shutdown_file })
}

fn shutdown_runtime(shared: &SharedRuntime) {
    let Ok(mut guard) = shared.lock() else {
        return;
    };
    let Some(mut runtime) = guard.take() else {
        return;
    };
    let _ = fs::write(&runtime.shutdown_file, b"shutdown\n");
    for _ in 0..30 {
        match runtime.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = runtime.child.kill();
    let _ = runtime.child.wait();
}

fn main() {
    let runtime: SharedRuntime = Arc::new(Mutex::new(None));
    let runtime_for_setup = Arc::clone(&runtime);
    let allowed_origin: AllowedOrigin = Arc::new(Mutex::new(None));
    let allowed_for_navigation = Arc::clone(&allowed_origin);
    let allowed_for_setup = Arc::clone(&allowed_origin);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("HarnessDock Next")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let origin = url.origin().ascii_serialization();
                    allowed_for_navigation
                        .lock()
                        .ok()
                        .and_then(|value| value.clone())
                        .is_some_and(|allowed| allowed == origin)
                })
                .build()?;

            if let Ok(override_url) = env::var("HARNESSDOCK_TAURI_URL") {
                match Url::parse(override_url.trim()) {
                    Ok(url) => {
                        if let Ok(mut allowed) = allowed_for_setup.lock() {
                            *allowed = Some(url.origin().ascii_serialization());
                        }
                        window.navigate(url)?;
                    }
                    Err(error) => set_status(&window, &format!("Invalid HARNESSDOCK_TAURI_URL: {error}")),
                }
                return Ok(());
            }

            match launch_runtime_bridge(app, window.clone(), Arc::clone(&allowed_for_setup)) {
                Ok(child) => {
                    if let Ok(mut runtime) = runtime_for_setup.lock() {
                        *runtime = Some(child);
                    }
                }
                Err(error) => {
                    eprintln!("[tauri] {error}");
                    set_status(&window, &error);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build HarnessDock Tauri host");

    app.run(move |_handle, event| {
        if matches!(event, RunEvent::Exit) {
            shutdown_runtime(&runtime);
        }
    });
}
