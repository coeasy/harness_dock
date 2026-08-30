# HarnessDock Tauri v0.2.0

This directory is the replacement host for the v0.2.0 client line.

## Runtime model

- **Windows / macOS / Linux:** Tauri owns and launches the packaged DeepSeek Harness runtime from `dsh-runtime/` and navigates the main WebView to the authenticated loopback URL returned by dsh.
- **Android / iOS:** no Node/dsh runtime is executed on-device. The launcher validates an HTTPS HarnessDock Gateway, exchanges an explicit one-time pairing code, then navigates to the same-origin connection URL so the Gateway can establish its HttpOnly session.
- **Remote-origin isolation:** the Tauri capability is intentionally local-only. After the WebView navigates to the local dsh or remote Gateway origin, that remote document is not granted Tauri command permissions.

## Mobile generation

Tauri generates the native platform projects from this source of truth:

```bash
cargo tauri android init --ci
cargo tauri android build --apk --aab --ci
cargo tauri ios init --ci
cargo tauri ios build --ci
```

CI first uses unsigned/debug Android and iOS-simulator builds as compile gates. Production signing is enabled only in the release workflow with repository secrets.
