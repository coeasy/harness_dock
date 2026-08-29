# HarnessDock Mobile Preview

Perry-based iOS/Android shell for the official Harness Web UI.

## Architecture

Mobile is **remote-runtime only**:

```text
Perry iOS / Android
  -> HTTPS HarnessDock Gateway
  -> local desktop dsh web
  -> official Harness Web UI
```

The mobile app never downloads, installs, or starts Node/dsh. This keeps the mobile package compatible with App Store / Play distribution constraints and avoids running a desktop process tree in a mobile sandbox.

## Pairing

1. Start HarnessDock Desktop with the gateway explicitly enabled.
2. Expose the loopback gateway through a trusted HTTPS endpoint (Tailscale, an authenticated reverse proxy, or equivalent).
3. Generate a one-time pairing code from the desktop gateway.
4. Enter the HTTPS gateway URL and code in the mobile client.
5. The code is exchanged for a short-lived one-time connect URL. The WebView consumes that URL and receives an HttpOnly session cookie.

Preview environment flags on Electron Desktop:

```text
HARNESSDOCK_GATEWAY_ENABLE=1
HARNESSDOCK_GATEWAY_PUBLIC_URL=https://your-gateway.example/
HARNESSDOCK_GATEWAY_PAIR_ON_START=1
```

`HARNESSDOCK_GATEWAY_PAIR_ON_START=1` intentionally shows one pairing code in a native notification and does not write that credential to logs.

## Current gates

Implemented:

- RemoteRuntimeProvider contract
- HTTPS requirement outside loopback development
- short-lived single-use pairing codes
- one-time connect tokens
- HttpOnly gateway session cookies
- HTTP reverse proxy
- WebSocket upgrade proxy
- iOS/Android Perry shell
- persistent WebView session store
- same-origin navigation enforcement

Still preview blockers:

- native file picker/upload bridge
- file download/export/share sheet
- OAuth external-browser callback handoff
- Keychain/Android Keystore credential persistence
- universal/app links
- push notifications
- signed IPA/AAB release pipeline and store metadata
- real-device WebSocket/reconnect/IME parity suite

These blockers are capability-gated rather than hidden behind mock implementations.
