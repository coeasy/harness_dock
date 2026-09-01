# HarnessDock Tauri v0.2.7

`apps/tauri` is the supported application host. Public desktop releases are **Full-only**: Windows, macOS and Linux packages include the pinned local DeepSeek Harness runtime. The legacy Electron Thin implementation remains in the repository for compatibility/testing but is not part of the Tauri candidate or GitHub Release.

## Runtime model

- Windows / macOS / Linux: packaged local runtime + Remote Gateway.
- Android / iOS: Remote Gateway only; Node/dsh is never started on-device.
- Third-party plugin failures are isolated by bounded recovery/quarantine and do not terminate the HarnessDock host.
- The packaged launcher reuses a compatible Node already on PATH; if that executable fails to boot the pinned Runtime, the launcher retries with the bundled portable Node. The bundled Node is never installed system-wide.
- A built-in `@deepseek-ai/dsh-client-runtime/client` compatibility layer keeps older plugins such as `dsh-at-file` from failing when the official package is now `dsh-client-modules`.
- Desktop startup always opens the isolated official Harness Web UI as the primary surface; the local control page stays hidden in the background and is only shown for startup recovery or explicit settings access.
- If normal plugin recovery cannot complete, a temporary clean DSH profile is used so the Web UI can still open without changing the user's real configuration.

The Harness WebView receives a minimal injected shell toolbar with `刷新 Web`, `重启 Web`, `设置`, `最小化`, `最大化/还原`, and `隐藏到托盘` controls. `刷新 Web` only reloads the WebView and preserves the Runtime/session; `重启 Web` stops the owned Gateway, restarts Runtime with overlap protection, and reopens the WebView at the new loopback URL. Clicking `设置` asynchronously creates or focuses the local Shell Settings plugin on demand; the native `HarnessDock` menu and system tray expose the same recovery actions as fallbacks. Closing the Harness window hides it to the tray, while the explicit tray `退出 HarnessDock` action performs full child-process cleanup. The settings plugin is never opened during startup, and the Web UI auto-open behavior is mandatory rather than a user toggle.

The desktop control page is a hidden bootstrap/recovery surface. It starts the local Runtime in the background and remains hidden when Harness Web opens successfully. Only a Runtime or Web navigation failure reveals the control page for recovery. Android/iOS keep their visible Remote Gateway entry page because they do not start a local Runtime. Update checking is available from Shell Settings and opens the matching GitHub release page; signed in-place installation is intentionally not enabled until updater signing keys and platform-specific release metadata are configured.

## Brand and installation contract

`src-tauri/icons/app-icon.png` is the 1024x1024 source of truth. Candidate builds run `cargo tauri icon` so desktop and generated Android/iOS projects share the HarnessDock icon. Windows NSIS also explicitly uses the HarnessDock icon for installer/uninstaller and branded wizard bitmaps. The candidate verifies the final installer PE resources so the default NSIS icon cannot silently return.

Windows keeps the stable application identifier `com.harnessdock.client`, installs per-user without elevation, blocks accidental downgrade installs, and embeds the WebView2 bootstrapper. This supports installing a newer HarnessDock over an existing v0.2.x installation while retaining the same app identity and user data directory.

## Build

```bash
cd apps/tauri
cargo tauri icon src-tauri/icons/app-icon.png
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

Public CI artifacts remain unsigned developer builds: Windows has no Authenticode signature, macOS is not notarized, Android is release-optimized but debug-signed, and iOS is Simulator-only. Release assets include SHA256SUMS. Tauri CLI defaults `android build` to release mode; use `--debug` only for local native debugging, since it retains a large unstripped shared library.
