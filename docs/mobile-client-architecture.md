# HarnessDock Mobile Client Architecture

Status: implementation preview on `feat-dual-host-perry-electron`

## 1. Decision

HarnessDock mobile uses Perry for the native iOS/Android shell, but it does **not** run the desktop runtime locally. The supported runtime topology is:

```text
Electron Desktop (Stable) ── LocalRuntimeProvider ── dsh web
                                         │
                                         └── HarnessDock Gateway
                                               │ HTTPS + WSS
                             ┌─────────────────┴─────────────────┐
                             │                                   │
                      Perry iOS                          Perry Android
                  RemoteRuntimeProvider              RemoteRuntimeProvider
                             │                                   │
                           WKWebView                    android.webkit.WebView
                             └──────── official Harness Web UI ───┘
```

This preserves the existing official Harness UI and `~/.dsh` state while keeping App Store / Play packages self-contained.

## 2. Runtime Provider boundary

`packages/bootstrap/src/runtime-provider.ts` defines one session shape for all hosts.

- `LocalRuntimeProvider`: existing desktop bootstrap/download/rollback process, wrapped without rewriting it.
- `RemoteRuntimeProvider`: gateway health + pairing only; it never calls `spawn`, never downloads dsh, and never owns a local runtime lease.

The mobile implementation imports only the platform-neutral remote provider file. Node-specific bootstrap/gateway modules are not in the Perry mobile module graph.

## 3. Host capability model

`host-capabilities.ts` explicitly describes capabilities instead of assuming every host behaves like Electron.

Mobile currently advertises:

- runtime: remote only
- downloads: false
- file picker: false
- native JS bridge: false
- service workers: false
- background runtime: false

This is deliberate. UI work should test capability flags and hide/replace unsupported host operations instead of shipping partial fake behavior.

## 4. Gateway security model

The Gateway is a desktop-side proxy in front of the loopback-only dsh server.

Defaults:

1. binds to `127.0.0.1`;
2. refuses insecure non-loopback public URLs;
3. expects TLS to terminate at a trusted local/edge reverse proxy;
4. does not expose dsh directly;
5. does not log pairing codes.

Pairing lifecycle:

```text
Desktop createPairingTicket()
  -> 8 digit code, TTL 5 minutes
Mobile POST /api/harnessdock/pair
  -> code consumed once
  -> random 256-bit launch token, TTL 60 seconds
Mobile WebView GET /api/harnessdock/connect?token=...
  -> token consumed once
  -> HttpOnly + SameSite=Strict session cookie
  -> redirect /
All later HTTP / WebSocket traffic
  -> valid session required
  -> proxy to local dsh web
```

The short pairing code is HMACed in memory with a process-random pepper. Session and launch tokens are generated from 32 random bytes. Pair attempts are rate limited per observed remote address.

## 5. Gateway activation

Gateway is opt-in during preview:

```text
HARNESSDOCK_GATEWAY_ENABLE=1
HARNESSDOCK_GATEWAY_BIND=127.0.0.1
HARNESSDOCK_GATEWAY_PORT=0
HARNESSDOCK_GATEWAY_PUBLIC_URL=https://your-device-or-tunnel.example/
HARNESSDOCK_GATEWAY_PAIR_ON_START=1
```

Recommended deployment is loopback Gateway + TLS overlay such as a private mesh/VPN or authenticated reverse proxy. `HARNESSDOCK_GATEWAY_ALLOW_INSECURE=1` exists only for controlled development and must not be used for Internet-facing traffic.

The pairing-on-start switch is explicit because a pairing code is a credential. The code is shown via a native Electron notification and intentionally excluded from boot logs.

## 6. Mobile Perry shell

`apps/mobile/src/main.ts` contains two routes:

- `connect`: HTTPS Gateway URL + pairing code + device name;
- `harness`: persistent Perry WebView loading the one-time connect URL and then the official Harness Web UI.

The WebView accepts navigation only to the paired Gateway origin. Cross-origin navigation is blocked in Preview until native external-browser/OAuth callback handling is implemented.

The WebView uses `ephemeral: false` because the Gateway authentication contract is an HttpOnly session cookie. Disconnect clears the WebView cookie/storage data before returning to the pairing screen.

## 7. WebSocket and streaming

The Gateway handles Node HTTP `upgrade` and pipes an authenticated WebSocket connection to the local dsh upstream. This is required for Harness streaming/session behavior; a HTTP-only reverse proxy would pass the landing page but break real agent usage.

Real-device gates still required:

- long streaming responses;
- Wi-Fi -> cellular transitions;
- background/foreground reconnect;
- sleep/wake reconnect;
- gateway restart;
- runtime restart;
- session expiry while WebView is open.

## 8. iOS/Android build gates

`.github/workflows/mobile-preview.yml` adds three independent jobs:

1. TypeScript + unit/integration validation on Ubuntu;
2. Perry `ios-simulator` native compile on macOS;
3. Perry `android` native compile on Ubuntu using the runner's installed Android NDK.

These are Preview compiler gates, not App Store / Play publication jobs. Signed IPA/AAB packaging, provisioning, notarization/store credentials and metadata belong to a later release workflow after functional parity is green.

## 9. File handling migration

Perry WebView intentionally does not provide Electron-style general download/file/RPC behavior. Mobile file features therefore must not depend on `<a download>` or hidden IPC assumptions.

Target flow:

```text
Native mobile file picker
  -> Gateway upload endpoint
  -> Harness workspace

Harness export / artifact
  -> Gateway download endpoint
  -> native Save/Share sheet
```

Until those native adapters exist, file picker/download/export remain capability-gated blockers.

## 10. Credential storage

Pairing code and launch token are intentionally short-lived and are not persisted. Long-lived device identity is not implemented yet.

Before Mobile Beta:

- iOS: store device credential in Keychain;
- Android: store device credential using Android Keystore-backed storage;
- Gateway: device registry with named devices, last-seen timestamp and revoke action;
- rotate credentials without re-pairing where possible;
- revoke all mobile sessions from Desktop diagnostics.

## 11. OAuth and external links

Preview blocks cross-origin WebView navigation. Beta needs a host service that:

1. opens the provider login in the system browser;
2. receives a Universal Link / App Link callback;
3. returns the callback to the Gateway/Harness session;
4. never exposes provider tokens to arbitrary WebView origins.

## 12. Product rollout

Recommended sequence:

### v0.2.x

- Electron Stable
- Perry Desktop Preview
- Perry iOS/Android Developer Preview
- opt-in Gateway
- no store publication

### v0.3.x

- mobile native file picker/share
- Keychain/Keystore device credentials
- deep links and OAuth handoff
- real-device reconnect suite
- signed TestFlight / Play Internal builds

### v0.4.x+

- Perry Desktop Beta where parity allows
- iOS/Android public Beta
- push approval/task notifications
- device management and session revocation
- platform-by-platform Stable promotion

## 13. Non-negotiable gates before public mobile release

- no local dsh download/exec on mobile;
- HTTPS required for non-loopback Gateway access;
- authenticated WebSocket proxy proven with real Harness streaming;
- native upload/download/export path;
- OAuth system-browser callback path;
- credentials in Keychain/Keystore, not plain files;
- pairing/session revocation UI;
- iOS and Android real-device IME/keyboard tests;
- app background/foreground reconnection tests;
- signed store packages built in isolated release jobs;
- privacy/security review for any analytics or push tokens.
