# HarnessDock Tauri v0.2.0

`apps/tauri` is the supported application host for HarnessDock v0.2.0.

## Runtime model

- **Windows / macOS / Linux:** Tauri owns the packaged DeepSeek Harness runtime and starts it on loopback. The local `main` WebView remains the trusted HarnessDock control surface; the official Harness UI opens in a separate `harness` WebView that is not included in the local Tauri capability allow-list.
- **Android / iOS:** Node/dsh is never started on-device. Mobile uses the authenticated HarnessDock Gateway and one-time pairing flow to reach a desktop/server runtime.
- **Gateway sidecar:** desktop Tauri owns the Gateway sidecar lifecycle, pairing codes, device sessions and revoke operations.
- **Remote-origin isolation:** only the local `main` window receives Tauri command permissions. Remote Harness/Gateway documents do not receive local Tauri IPC capabilities.

## Build prerequisites

Tauri 2 requires Rust plus each target platform's native toolchain. The repository CI is the reference build environment.

Desktop candidate examples:

```bash
cd apps/tauri
cargo tauri build --bundles nsis        # Windows
cargo tauri build --bundles deb,appimage # Linux
cargo tauri build --bundles dmg         # macOS
```

Mobile native projects are generated from the same Tauri source of truth:

```bash
cd apps/tauri
cargo tauri android init --ci
cargo tauri android build --debug --apk --aab --target aarch64 --ci
cargo tauri ios init --ci
cargo tauri ios build --debug --target aarch64-sim --ci
```

## Distribution status

The v0.2.0 public pipeline validates native Android and iOS builds, but mobile release artifacts are developer previews:

- Android: debug APK/AAB; not Google Play production-signed.
- iOS: arm64 Simulator build; no App Store/TestFlight IPA without Apple signing/provisioning credentials.
- Desktop: public CI currently does not apply Windows Authenticode or Apple Developer ID notarization.

The formal GitHub Release publishes SHA-256 checksums for the generated assets.
