# HarnessDock Tauri v0.2.0

The normal desktop path is shell-first: native startup launches the pinned Full Runtime and the first business surface is the official Harness Web. The top bar is supplied by the independently installable `@dsh/plugin-harness-shell` package through a v1 host bridge.

`apps/tauri` is the only desktop application host. Public desktop releases are **Full-only**: Windows, macOS and Linux packages include the pinned local DeepSeek Harness runtime. Electron application code, packaging and E2E paths are not part of v0.2.0.

## Runtime model

- Windows / macOS / Linux: packaged local runtime + Remote Gateway.
- Android / iOS: Remote Gateway only; Node/dsh is never started on-device.
- Third-party plugin failures are isolated by bounded recovery/quarantine and do not terminate the HarnessDock host.
- The packaged launcher reuses a compatible Node already on PATH; if that executable fails to boot the pinned Runtime, the launcher retries with the bundled portable Node. The bundled Node is never installed system-wide.
- A built-in `@deepseek-ai/dsh-client-runtime/client` compatibility layer keeps older plugins such as `dsh-at-file` from failing when the official package is now `dsh-client-modules`.
- Desktop startup is coordinated by the native Rust host and always opens the isolated official Harness Web UI as the primary surface; the local control page stays hidden in the background and is only shown for startup recovery or explicit settings access.
- If normal plugin recovery cannot complete, a temporary clean DSH profile is used so the Web UI can still open without changing the user's real configuration.

The Harness WebView receives a minimal injected shell toolbar with one `菜单` button, `最小化`, `最大化/还原`, and `关闭` controls. The menu contains `刷新 Web`, `重启 Runtime 并刷新 Web`, `清除插件隔离并重启`, `插件诊断`, and `自动更新`; refresh, restart, recovery, and update actions execute directly in the current Web window with a busy state, duplicate-command blocking, and a transient local splash. `刷新 Web` preserves the Runtime/session; Runtime restart stops the owned Gateway first, restarts Runtime with overlap protection, and reopens the WebView at the new loopback URL. The diagnostics page is read-only for Runtime/plugin state plus client exit, so it does not duplicate the main Web actions. Only the explicit `插件诊断` menu item opens the compact centered diagnostics plugin on demand; it is never opened during startup. The native Tauri menu and system tray expose the same actions as OS-level fallbacks. Closing a window hides it to the tray; only the explicit tray/diagnostics exit action performs controlled child-process cleanup and terminates HarnessDock.

The desktop `main` page is a hidden bootstrap/recovery surface; native `startup.rs` starts the Runtime, validates its loopback URL and opens Harness Web. A local centered splash shows startup progress and a 20-second WebView watchdog converts a missing first paint into a recovery page instead of an invisible/terminated client. Only a Runtime or Web navigation failure reveals the control page for recovery. Android/iOS keep their visible Remote Gateway entry page because they do not start a local Runtime. The update menu first compares the installed version with the latest stable GitHub Release. If a newer version exists, it proceeds only through Tauri's signed updater path and restarts after the downloaded artifact is verified and installed. Desktop candidate jobs require `HARNESSDOCK_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and the optional key password; the release job assembles the four signed desktop targets and generates the matching `latest.json`. If signing material is unavailable in a local/developer build, the menu reports the newer version and gives the matching GitHub release page for manual updates rather than installing an unsigned executable.

## Brand and installation contract

`src-tauri/icons/app-icon.png` is the 1024x1024 source of truth. Candidate builds run `cargo tauri icon` so desktop and generated Android/iOS projects share the HarnessDock icon. Windows NSIS explicitly uses the HarnessDock icon for the installer and uninstaller, and the candidate verifies the final installer PE resources so the default NSIS icon cannot silently return.

Windows keeps the stable application identifier `com.harnessdock.client`, installs per-user without elevation, blocks accidental downgrade installs, and embeds the WebView2 bootstrapper. This supports installing a newer HarnessDock over an existing v0.2.x installation while retaining the same app identity and user data directory.

## Build

```bash
cd apps/tauri
cargo tauri icon src-tauri/icons/app-icon.png # optional; tauri:dev/build also runs this
cargo tauri build --bundles nsis         # Windows
cargo tauri build --bundles deb,appimage # Linux
cargo tauri build --bundles dmg          # macOS
```

Mobile projects must be initialized before regenerating icons:

```bash
cargo tauri android init --ci
cargo tauri icon src-tauri/icons/app-icon.png
cargo tauri android build --apk --aab --target aarch64 --ci

cargo tauri ios init --ci
cargo tauri icon src-tauri/icons/app-icon.png
cargo tauri ios build --debug --target aarch64-sim --ci
```

Public CI artifacts remain unsigned developer builds at the OS signing layer: Windows has no Authenticode signature, macOS is not notarized, Android is release-optimized but debug-signed, and iOS is Simulator-only. The desktop release also carries Tauri updater signatures (`.sig`) and `latest.json`; those signatures authenticate updater payloads but do not replace Authenticode, notarization or store signing. Release assets include SHA256SUMS. Tauri CLI defaults `android build` to release mode; use `--debug` only for local native debugging, since it retains a large unstripped shared library.
